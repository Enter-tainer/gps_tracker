use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::mutex::Mutex;

use crate::system_info::GpsState;

const AGNSS_TRIGGER_DELAY_MS: u64 = 10_000;
const T_AGNSS_MESSAGE_SEND_TIMEOUT_MS: u64 = 1;
const T_AGNSS_TOTAL_TIMEOUT_MS: u64 = 600_000;
const MAX_AGNSS_MESSAGE_RETRY: u8 = 3;
const MAX_AGNSS_MESSAGES: usize = 70;
pub const MAX_AGNSS_MESSAGE_SIZE: usize = 568;

#[derive(Clone, Copy)]
pub struct AgnssMessage {
    pub len: usize,
    pub data: [u8; MAX_AGNSS_MESSAGE_SIZE],
}

impl AgnssMessage {
    pub const fn empty() -> Self {
        Self {
            len: 0,
            data: [0; MAX_AGNSS_MESSAGE_SIZE],
        }
    }

    pub fn from_slice(data: &[u8]) -> Option<Self> {
        if data.len() > MAX_AGNSS_MESSAGE_SIZE {
            return None;
        }
        let mut msg = Self::empty();
        msg.len = data.len();
        msg.data[..data.len()].copy_from_slice(data);
        Some(msg)
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.data[..self.len]
    }
}

struct AgnssQueue {
    messages: [AgnssMessage; MAX_AGNSS_MESSAGES],
    len: usize,
}

impl AgnssQueue {
    const fn new() -> Self {
        Self {
            messages: [AgnssMessage::empty(); MAX_AGNSS_MESSAGES],
            len: 0,
        }
    }

    fn clear(&mut self) {
        self.len = 0;
    }

    fn is_empty(&self) -> bool {
        self.len == 0
    }

    fn len(&self) -> usize {
        self.len
    }

    fn push(&mut self, data: &[u8]) -> Result<(), AgnssQueueError> {
        if self.len >= MAX_AGNSS_MESSAGES {
            return Err(AgnssQueueError::TooManyMessages);
        }
        let msg = AgnssMessage::from_slice(data).ok_or(AgnssQueueError::MessageTooLarge)?;
        self.messages[self.len] = msg;
        self.len += 1;
        Ok(())
    }

    fn get_copy(&self, index: usize) -> Option<AgnssMessage> {
        if index < self.len {
            Some(self.messages[index])
        } else {
            None
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgnssQueueError {
    TooManyMessages,
    MessageTooLarge,
}

#[derive(Clone, Copy)]
pub(super) enum AgnssOutcome {
    Send(AgnssMessage),
    Complete,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum AgnssAck {
    None,
    Ack,
    Nack,
}

struct AgnssState {
    queue: AgnssQueue,
    request_pending: bool,
    force_trigger: bool,
    current_index: usize,
    current_retry: u8,
    message_timer_start: Option<u64>,
    total_timer_start: Option<u64>,
    previous_state: GpsState,
}

impl AgnssState {
    const fn new() -> Self {
        Self {
            queue: AgnssQueue::new(),
            request_pending: true,
            force_trigger: false,
            current_index: 0,
            current_retry: 0,
            message_timer_start: None,
            total_timer_start: None,
            previous_state: GpsState::S2IdleGpsOff,
        }
    }

    fn clear_processing(&mut self) {
        self.current_index = 0;
        self.current_retry = 0;
        self.message_timer_start = None;
        self.total_timer_start = None;
    }

    fn clear_all(&mut self) {
        self.queue.clear();
        self.request_pending = false;
        self.force_trigger = false;
        self.clear_processing();
    }

    fn should_trigger(&self, now_ms: u64, state: GpsState) -> bool {
        now_ms >= AGNSS_TRIGGER_DELAY_MS
            && (self.request_pending || self.force_trigger)
            && !self.queue.is_empty()
            && state != GpsState::S5AgnssProcessing
    }

    fn start_processing(&mut self, now_ms: u64, previous_state: GpsState) -> Option<AgnssMessage> {
        if self.queue.is_empty() {
            return None;
        }
        self.previous_state = previous_state;
        self.request_pending = false;
        self.force_trigger = false;
        self.current_index = 0;
        self.current_retry = 0;
        self.message_timer_start = None;
        self.total_timer_start = Some(now_ms);
        self.queue.get_copy(self.current_index)
    }

    fn mark_message_sent(&mut self, now_ms: u64) {
        self.message_timer_start = Some(now_ms);
    }

    fn ack_next(&mut self) -> AgnssOutcome {
        self.message_timer_start = None;
        self.current_index = self.current_index.saturating_add(1);
        self.current_retry = 0;
        if self.current_index >= self.queue.len() {
            AgnssOutcome::Complete
        } else {
            self.queue
                .get_copy(self.current_index)
                .map(AgnssOutcome::Send)
                .unwrap_or(AgnssOutcome::Complete)
        }
    }

    fn retry_or_fail(&mut self) -> AgnssOutcome {
        self.current_retry = self.current_retry.saturating_add(1);
        if self.current_retry >= MAX_AGNSS_MESSAGE_RETRY {
            return AgnssOutcome::Complete;
        }
        self.queue
            .get_copy(self.current_index)
            .map(AgnssOutcome::Send)
            .unwrap_or(AgnssOutcome::Complete)
    }

    fn message_timeout(&self, now_ms: u64) -> bool {
        match self.message_timer_start {
            Some(start) => now_ms.wrapping_sub(start) >= T_AGNSS_MESSAGE_SEND_TIMEOUT_MS,
            None => false,
        }
    }

    fn total_timeout(&self, now_ms: u64) -> bool {
        match self.total_timer_start {
            Some(start) => now_ms.wrapping_sub(start) >= T_AGNSS_TOTAL_TIMEOUT_MS,
            None => false,
        }
    }
}

static AGNSS_STATE: Mutex<CriticalSectionRawMutex, AgnssState> = Mutex::new(AgnssState::new());

pub async fn set_agnss_message_queue(messages: &[&[u8]]) -> Result<(), AgnssQueueError> {
    let mut agnss = AGNSS_STATE.lock().await;
    agnss.queue.clear();
    for message in messages {
        if let Err(err) = agnss.queue.push(message) {
            agnss.queue.clear();
            agnss.request_pending = false;
            agnss.force_trigger = false;
            return Err(err);
        }
    }
    agnss.request_pending = !agnss.queue.is_empty();
    agnss.force_trigger = false;
    Ok(())
}

pub(super) async fn agnss_should_trigger(now_ms: u64, state: GpsState) -> bool {
    let agnss = AGNSS_STATE.lock().await;
    agnss.should_trigger(now_ms, state)
}

pub(super) async fn agnss_start_processing(
    state: GpsState,
    now_ms: u64,
) -> Option<AgnssMessage> {
    let mut agnss = AGNSS_STATE.lock().await;
    agnss.start_processing(now_ms, state)
}

pub(super) async fn agnss_mark_message_sent(now_ms: u64) {
    let mut agnss = AGNSS_STATE.lock().await;
    agnss.mark_message_sent(now_ms);
}

pub(super) async fn agnss_ack_next() -> AgnssOutcome {
    let mut agnss = AGNSS_STATE.lock().await;
    agnss.ack_next()
}

pub(super) async fn agnss_retry_or_fail() -> AgnssOutcome {
    let mut agnss = AGNSS_STATE.lock().await;
    agnss.retry_or_fail()
}

pub(super) async fn agnss_message_timeout(now_ms: u64) -> bool {
    let agnss = AGNSS_STATE.lock().await;
    agnss.message_timeout(now_ms)
}

pub(super) async fn agnss_total_timeout(now_ms: u64) -> bool {
    let agnss = AGNSS_STATE.lock().await;
    agnss.total_timeout(now_ms)
}

pub(super) async fn agnss_finish_processing() -> GpsState {
    let mut agnss = AGNSS_STATE.lock().await;
    let previous_state = agnss.previous_state;
    agnss.clear_all();
    previous_state
}

pub(super) async fn agnss_note_motion() {
    let mut agnss = AGNSS_STATE.lock().await;
    match agnss.previous_state {
        GpsState::S2IdleGpsOff | GpsState::S4AnalyzingStillness => {
            agnss.previous_state = GpsState::S3TrackingFixed;
        }
        _ => {}
    }
}
