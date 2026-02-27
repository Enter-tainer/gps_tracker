//! Priority-based BLE advertising scheduler.
//!
//! The nRF SoftDevice S140 supports only one advertising set handle.
//! This module arbitrates access between connectable (main BLE) and
//! non-connectable (Find My / FMDN) advertising using a cooperative
//! preemption model with round-robin alternation for background tasks.
//!
//! # Design
//!
//! - `acquire(priority).await` blocks until the resource is granted.
//! - Higher-priority callers preempt lower-priority holders via signal.
//! - `AdvGuard::wait_preempted().await` lets holders react to preemption.
//! - `drop(guard)` releases the resource and wakes the next waiter.
//! - Background tasks (FindMy / FMDN) alternate via round-robin: when one
//!   releases, the other is granted first if waiting.

use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::blocking_mutex::Mutex;
use embassy_sync::signal::Signal;

use core::cell::RefCell;

const PRIORITY_COUNT: usize = 3;

/// Time slice for background advertising alternation (seconds).
/// Each background task (FindMy / FMDN) advertises for this duration
/// before yielding to allow the other task a turn.
pub const ALTERNATION_SECS: u64 = 5;

/// Advertising priority (lower value = higher priority).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum AdvPriority {
    MainAdv = 0,
    FindMyAdv = 1,
    FmdnAdv = 2,
}

impl AdvPriority {
    fn from_index(index: usize) -> Self {
        match index {
            0 => Self::MainAdv,
            _ => Self::FindMyAdv,
        }
    }
}

struct SchedulerState {
    current_holder: Option<AdvPriority>,
    waiting: [bool; PRIORITY_COUNT],
}

pub struct AdvScheduler {
    state: Mutex<CriticalSectionRawMutex, RefCell<SchedulerState>>,
    grant_signals: [Signal<CriticalSectionRawMutex, ()>; PRIORITY_COUNT],
    preempt_signals: [Signal<CriticalSectionRawMutex, ()>; PRIORITY_COUNT],
}

impl AdvScheduler {
    pub const fn new() -> Self {
        Self {
            state: Mutex::new(RefCell::new(SchedulerState {
                current_holder: None,
                waiting: [false; PRIORITY_COUNT],
            })),
            grant_signals: [Signal::new(), Signal::new(), Signal::new()],
            preempt_signals: [Signal::new(), Signal::new(), Signal::new()],
        }
    }

    /// Acquire the advertising resource. Blocks until granted.
    ///
    /// If a lower-priority holder exists, it is signalled to yield.
    pub async fn acquire(&self, priority: AdvPriority) -> AdvGuard<'_> {
        loop {
            let needs_wait = self.state.lock(|s| {
                let mut st = s.borrow_mut();
                match st.current_holder {
                    None => {
                        st.current_holder = Some(priority);
                        false
                    }
                    Some(holder) if holder == priority => {
                        // Already granted to us by release(). Claim it.
                        false
                    }
                    Some(holder) if priority < holder => {
                        // Higher priority: preempt current holder.
                        self.preempt_signals[holder as usize].signal(());
                        st.waiting[priority as usize] = true;
                        true
                    }
                    _ => {
                        // Lower or equal priority: queue up.
                        st.waiting[priority as usize] = true;
                        true
                    }
                }
            });

            if !needs_wait {
                return AdvGuard {
                    scheduler: self,
                    priority,
                };
            }

            self.grant_signals[priority as usize].wait().await;
        }
    }

    fn release(&self, priority: AdvPriority) {
        self.state.lock(|s| {
            let mut st = s.borrow_mut();
            if st.current_holder != Some(priority) {
                return;
            }
            st.current_holder = None;

            // Always check MainAdv (highest priority) first.
            if st.waiting[AdvPriority::MainAdv as usize] {
                st.waiting[AdvPriority::MainAdv as usize] = false;
                st.current_holder = Some(AdvPriority::MainAdv);
                self.grant_signals[AdvPriority::MainAdv as usize].signal(());
                return;
            }

            // For background tasks, prefer the OTHER background task (round-robin).
            let (first, second) = match priority {
                AdvPriority::FindMyAdv => (AdvPriority::FmdnAdv, AdvPriority::FindMyAdv),
                AdvPriority::FmdnAdv => (AdvPriority::FindMyAdv, AdvPriority::FmdnAdv),
                _ => (AdvPriority::FindMyAdv, AdvPriority::FmdnAdv),
            };

            for p in [first, second] {
                if st.waiting[p as usize] {
                    st.waiting[p as usize] = false;
                    st.current_holder = Some(p);
                    self.grant_signals[p as usize].signal(());
                    return;
                }
            }
        });
    }
}

/// RAII guard for the advertising resource.
///
/// Dropping the guard releases the resource and wakes any waiters.
pub struct AdvGuard<'a> {
    scheduler: &'a AdvScheduler,
    priority: AdvPriority,
}

impl AdvGuard<'_> {
    /// Block until a higher-priority caller preempts this holder.
    ///
    /// When this returns, the caller should stop advertising and drop the guard.
    pub async fn wait_preempted(&self) {
        self.scheduler.preempt_signals[self.priority as usize]
            .wait()
            .await;
    }
}

impl Drop for AdvGuard<'_> {
    fn drop(&mut self) {
        self.scheduler.release(self.priority);
    }
}

pub static ADV_SCHEDULER: AdvScheduler = AdvScheduler::new();
