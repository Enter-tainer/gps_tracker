use crate::gps;
use crate::storage;
use crate::system_info::{serialize_system_info, SYSTEM_INFO, SYSTEM_INFO_SERIALIZED_LEN};

const CMD_LIST_DIR: u8 = 0x01;
const CMD_OPEN_FILE: u8 = 0x02;
const CMD_READ_CHUNK: u8 = 0x03;
const CMD_CLOSE_FILE: u8 = 0x04;
const CMD_DELETE_FILE: u8 = 0x05;
const CMD_GET_SYS_INFO: u8 = 0x06;
const CMD_START_AGNSS_WRITE: u8 = 0x07;
const CMD_WRITE_AGNSS_CHUNK: u8 = 0x08;
const CMD_END_AGNSS_WRITE: u8 = 0x09;
const CMD_GPS_WAKEUP: u8 = 0x0A;

const MAX_CMD_PAYLOAD: usize = 570;
const MAX_RESPONSE_PAYLOAD: usize = 256;
const MAX_RESPONSE_LEN: usize = 2 + MAX_RESPONSE_PAYLOAD;
const READ_CHUNK_MAX_DATA: usize = 254;
const LIST_DIR_RESPONSE_MAX: usize = 128;
const MAX_AGNSS_MESSAGES: usize = 64;
const MAX_AGNSS_MESSAGE_SIZE: usize = 568;

#[derive(Clone, Copy)]
enum CommandState {
    WaitCmdId,
    WaitPayloadLenLsb,
    WaitPayloadLenMsb,
    WaitPayload,
    ProcessCommand,
}

#[derive(Clone, Copy)]
struct AgnssMessage {
    len: usize,
    data: [u8; MAX_AGNSS_MESSAGE_SIZE],
}

impl AgnssMessage {
    const fn empty() -> Self {
        Self {
            len: 0,
            data: [0; MAX_AGNSS_MESSAGE_SIZE],
        }
    }
}

pub struct FileTransferProtocol {
    cmd_state: CommandState,
    cmd_id: u8,
    payload_len: u16,
    bytes_read: u16,
    buffer: [u8; MAX_CMD_PAYLOAD],
    response: [u8; MAX_RESPONSE_LEN],
    agnss_messages: [AgnssMessage; MAX_AGNSS_MESSAGES],
    agnss_len: usize,
    agnss_write_in_progress: bool,
}

impl FileTransferProtocol {
    pub const fn new() -> Self {
        Self {
            cmd_state: CommandState::WaitCmdId,
            cmd_id: 0,
            payload_len: 0,
            bytes_read: 0,
            buffer: [0; MAX_CMD_PAYLOAD],
            response: [0; MAX_RESPONSE_LEN],
            agnss_messages: [AgnssMessage::empty(); MAX_AGNSS_MESSAGES],
            agnss_len: 0,
            agnss_write_in_progress: false,
        }
    }

    pub fn response(&self, len: usize) -> &[u8] {
        &self.response[..len]
    }

    pub async fn push_byte(&mut self, byte: u8) -> Option<usize> {
        match self.cmd_state {
            CommandState::WaitCmdId => {
                self.cmd_id = byte;
                self.cmd_state = CommandState::WaitPayloadLenLsb;
            }
            CommandState::WaitPayloadLenLsb => {
                self.payload_len = byte as u16;
                self.cmd_state = CommandState::WaitPayloadLenMsb;
            }
            CommandState::WaitPayloadLenMsb => {
                self.payload_len |= (byte as u16) << 8;
                if self.payload_len as usize > MAX_CMD_PAYLOAD {
                    self.reset_state();
                    return None;
                }
                if self.payload_len == 0 {
                    self.cmd_state = CommandState::ProcessCommand;
                    return self.handle_command().await;
                }
                self.bytes_read = 0;
                self.cmd_state = CommandState::WaitPayload;
            }
            CommandState::WaitPayload => {
                if (self.bytes_read as usize) < self.buffer.len() {
                    self.buffer[self.bytes_read as usize] = byte;
                }
                self.bytes_read = self.bytes_read.saturating_add(1);
                if self.bytes_read == self.payload_len {
                    self.cmd_state = CommandState::ProcessCommand;
                    return self.handle_command().await;
                }
            }
            CommandState::ProcessCommand => {
                self.reset_state();
            }
        }
        None
    }

    fn reset_state(&mut self) {
        self.cmd_state = CommandState::WaitCmdId;
        self.cmd_id = 0;
        self.payload_len = 0;
        self.bytes_read = 0;
    }

    async fn handle_command(&mut self) -> Option<usize> {
        let payload_len = self.payload_len as usize;
        let mut payload_buf = [0u8; MAX_CMD_PAYLOAD];
        if payload_len > 0 {
            payload_buf[..payload_len].copy_from_slice(&self.buffer[..payload_len]);
        }
        let payload = &payload_buf[..payload_len];

        let response_len = match self.cmd_id {
            CMD_LIST_DIR => self.handle_list_dir(payload).await,
            CMD_OPEN_FILE => self.handle_open_file(payload).await,
            CMD_READ_CHUNK => self.handle_read_chunk(payload).await,
            CMD_CLOSE_FILE => Some(self.encode_empty_response()),
            CMD_DELETE_FILE => Some(self.encode_empty_response()),
            CMD_GET_SYS_INFO => self.handle_get_sys_info().await,
            CMD_START_AGNSS_WRITE => self.handle_start_agnss_write(),
            CMD_WRITE_AGNSS_CHUNK => self.handle_write_agnss_chunk(payload),
            CMD_END_AGNSS_WRITE => self.handle_end_agnss_write().await,
            CMD_GPS_WAKEUP => self.handle_gps_wakeup().await,
            _ => Some(self.encode_empty_response()),
        };

        if self.cmd_id == CMD_CLOSE_FILE {
            let _ = storage::close_file().await;
        } else if self.cmd_id == CMD_DELETE_FILE {
            let path_len = payload.get(0).copied().unwrap_or(0) as usize;
            let path_len = core::cmp::min(path_len, payload_len.saturating_sub(1));
            let path = &payload[1..1 + path_len];
            let _ = storage::delete_file(path).await;
        }

        self.reset_state();
        response_len
    }

    async fn handle_list_dir(&mut self, payload: &[u8]) -> Option<usize> {
        let payload_len = payload.len();
        let path_len = payload.get(0).copied().unwrap_or(0) as usize;
        let path_len = core::cmp::min(path_len, payload_len.saturating_sub(1));
        let path = &payload[1..1 + path_len];

        match storage::list_dir_next(path).await {
            storage::ListDirOutcome::Entry {
                is_dir,
                name,
                name_len,
                size,
            } => {
                let mut cursor = 0usize;
                self.response[2] = 0x01;
                cursor += 1;
                self.response[2 + cursor] = if is_dir { 0x01 } else { 0x00 };
                cursor += 1;
                let max_name_len = LIST_DIR_RESPONSE_MAX
                    .saturating_sub(3)
                    .saturating_sub(if is_dir { 0 } else { 4 });
                let safe_name_len = core::cmp::min(name_len, max_name_len);
                self.response[2 + cursor] = safe_name_len as u8;
                cursor += 1;
                if safe_name_len > 0 {
                    self.response[2 + cursor..2 + cursor + safe_name_len]
                        .copy_from_slice(&name[..safe_name_len]);
                    cursor += safe_name_len;
                }
                if !is_dir {
                    self.response[2 + cursor..2 + cursor + 4].copy_from_slice(&size.to_le_bytes());
                    cursor += 4;
                }
                Some(self.encode_response(cursor))
            }
            storage::ListDirOutcome::Done => {
                self.response[2] = 0x00;
                Some(self.encode_response(1))
            }
            storage::ListDirOutcome::Error => Some(self.encode_empty_response()),
        }
    }

    async fn handle_open_file(&mut self, payload: &[u8]) -> Option<usize> {
        let payload_len = payload.len();
        let path_len = payload.get(0).copied().unwrap_or(0) as usize;
        let path_len = core::cmp::min(path_len, payload_len.saturating_sub(1));
        let path = &payload[1..1 + path_len];

        let Some(size) = storage::open_file(path).await else {
            return Some(self.encode_empty_response());
        };
        self.response[2..6].copy_from_slice(&size.to_le_bytes());
        Some(self.encode_response(4))
    }

    async fn handle_read_chunk(&mut self, payload: &[u8]) -> Option<usize> {
        if payload.len() < 6 {
            self.response[2] = 0;
            self.response[3] = 0;
            return Some(self.encode_response(2));
        }

        let mut offset_bytes = [0u8; 4];
        offset_bytes.copy_from_slice(&payload[0..4]);
        let offset = u32::from_le_bytes(offset_bytes);

        let mut size_bytes = [0u8; 2];
        size_bytes.copy_from_slice(&payload[4..6]);
        let mut bytes_to_read = u16::from_le_bytes(size_bytes) as usize;
        bytes_to_read = core::cmp::min(bytes_to_read, READ_CHUNK_MAX_DATA);

        let mut data_buf = [0u8; READ_CHUNK_MAX_DATA];
        let actual = match storage::read_file(offset, &mut data_buf[..bytes_to_read]).await {
            Ok(n) => n,
            Err(_) => 0,
        };

        let actual_u16 = actual as u16;
        self.response[2..4].copy_from_slice(&actual_u16.to_le_bytes());
        if actual > 0 {
            self.response[4..4 + actual].copy_from_slice(&data_buf[..actual]);
        }
        Some(self.encode_response(2 + actual))
    }

    async fn handle_get_sys_info(&mut self) -> Option<usize> {
        let info = SYSTEM_INFO.lock().await;
        let mut payload = [0u8; SYSTEM_INFO_SERIALIZED_LEN];
        let payload_len = serialize_system_info(&info, &mut payload);
        self.response[2..2 + payload_len].copy_from_slice(&payload[..payload_len]);
        Some(self.encode_response(payload_len))
    }

    fn handle_start_agnss_write(&mut self) -> Option<usize> {
        self.agnss_len = 0;
        self.agnss_write_in_progress = true;
        Some(self.encode_empty_response())
    }

    fn handle_write_agnss_chunk(&mut self, payload: &[u8]) -> Option<usize> {
        if !self.agnss_write_in_progress {
            return Some(self.encode_empty_response());
        }
        if payload.len() < 2 {
            return Some(self.encode_empty_response());
        }

        let chunk_size = u16::from_le_bytes([payload[0], payload[1]]) as usize;
        if chunk_size == 0 || chunk_size > payload.len().saturating_sub(2) {
            return Some(self.encode_empty_response());
        }
        if chunk_size > MAX_AGNSS_MESSAGE_SIZE || self.agnss_len >= self.agnss_messages.len() {
            return Some(self.encode_empty_response());
        }

        let mut msg = AgnssMessage::empty();
        msg.len = chunk_size;
        msg.data[..chunk_size].copy_from_slice(&payload[2..2 + chunk_size]);
        self.agnss_messages[self.agnss_len] = msg;
        self.agnss_len += 1;

        Some(self.encode_empty_response())
    }

    async fn handle_end_agnss_write(&mut self) -> Option<usize> {
        if !self.agnss_write_in_progress {
            return Some(self.encode_empty_response());
        }
        self.agnss_write_in_progress = false;

        let mut slices: [Option<&[u8]>; MAX_AGNSS_MESSAGES] = [None; MAX_AGNSS_MESSAGES];
        for (idx, msg) in self.agnss_messages.iter().take(self.agnss_len).enumerate() {
            slices[idx] = Some(&msg.data[..msg.len]);
        }
        let mut ready: [&[u8]; MAX_AGNSS_MESSAGES] = [&[]; MAX_AGNSS_MESSAGES];
        let mut count = 0usize;
        for slice in slices.iter().flatten() {
            ready[count] = *slice;
            count += 1;
        }

        let _ = gps::set_agnss_message_queue(&ready[..count]).await;
        Some(self.encode_empty_response())
    }

    async fn handle_gps_wakeup(&mut self) -> Option<usize> {
        gps::trigger_gps_wakeup().await;
        Some(self.encode_empty_response())
    }

    fn encode_response(&mut self, payload_len: usize) -> usize {
        let payload_len = core::cmp::min(payload_len, MAX_RESPONSE_PAYLOAD);
        let len_bytes = (payload_len as u16).to_le_bytes();
        self.response[0] = len_bytes[0];
        self.response[1] = len_bytes[1];
        2 + payload_len
    }

    fn encode_empty_response(&mut self) -> usize {
        self.response[0] = 0;
        self.response[1] = 0;
        2
    }
}
