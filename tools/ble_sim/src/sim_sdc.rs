//! In-process mock BLE 5.0 SoftDevice Controller (`SimSdc`) speaking raw HCI over `bt-hci`.
//!
//! Enforces real nRF52840 / `nrf-sdc` controller invariants so `trouble-host 0.8.0`
//! exercises its real HCI framing, extended advertising state machine, L2CAP, and ATT/GATT stack:
//! - Configurable `max_adv_sets` (default 2)
//! - No factory public BD_ADDR by default (rejects `AddrKind::PUBLIC` with `0x12`)
//! - Strict separation of Legacy vs Extended advertising HCI commands (rejects mixing with `0x0C`)
//! - Independent `LeSetAdvSetRandomAddr` per advertising handle (`0`, `1`, ...)
//! - Simulates Central connect on Set 0 while leaving Set 1 (Find My) enabled
//! - Injects/captures real L2CAP CID `0x0004` ATT PDUs and manages host ACL flow credits

use std::collections::BTreeMap;
use std::convert::Infallible;
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bt_hci::controller::ExternalController;
use bt_hci::transport::{PacketKind, PacketToController, PacketToHost, Transport};
use bt_hci::ReadHciError;
use tokio::sync::mpsc;

/// Transport / controller wrapper error type compatible with `bt-hci::ExternalController`.
#[derive(Debug, Clone)]
pub struct SimTransportError(pub String);

impl fmt::Display for SimTransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SimTransportError {}

impl embedded_io::Error for SimTransportError {
    fn kind(&self) -> embedded_io::ErrorKind {
        embedded_io::ErrorKind::Other
    }
}

impl From<ReadHciError<Infallible>> for SimTransportError {
    fn from(value: ReadHciError<Infallible>) -> Self {
        Self(format!("ReadHciError: {value:?}"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdvApiMode {
    Legacy,
    Extended,
}

#[derive(Debug, Clone, Default)]
pub struct AdvSetSnapshot {
    pub handle: u8,
    pub props: u16,
    pub interval_min_units: u32,
    pub interval_max_units: u32,
    pub own_addr_kind: u8,
    pub random_addr: Option<[u8; 6]>,
    pub adv_data: Vec<u8>,
    pub scan_data: Vec<u8>,
    pub enabled: bool,
}

#[derive(Debug)]
pub struct SimSdcState {
    pub max_adv_sets: u8,
    pub has_public_addr: bool,
    pub used_adv_api: Option<AdvApiMode>,
    pub default_random_addr: Option<[u8; 6]>,
    pub adv_sets: BTreeMap<u8, AdvSetSnapshot>,
    pub cmd_log: Vec<u16>,
    pub tx_acl_packets: Vec<(u16, Vec<u8>)>,
    pub active_connections: BTreeMap<u16, u8>,
}

impl SimSdcState {
    fn new(max_adv_sets: u8, has_public_addr: bool) -> Self {
        Self {
            max_adv_sets,
            has_public_addr,
            used_adv_api: None,
            default_random_addr: None,
            adv_sets: BTreeMap::new(),
            cmd_log: Vec::new(),
            tx_acl_packets: Vec::new(),
            active_connections: BTreeMap::new(),
        }
    }
}

/// Controller configuration knobs for simulation tests.
#[derive(Debug, Clone, Copy)]
pub struct SimSdcConfig {
    pub max_adv_sets: u8,
    pub has_public_addr: bool,
}

impl Default for SimSdcConfig {
    fn default() -> Self {
        Self {
            max_adv_sets: 2,
            has_public_addr: false,
        }
    }
}

/// Handle used by tests to inspect controller state and inject over-the-air events / ATT PDUs.
#[derive(Clone)]
pub struct SimSdcHandle {
    state: Arc<Mutex<SimSdcState>>,
    to_host_tx: mpsc::UnboundedSender<Vec<u8>>,
    att_out_rx: Arc<tokio::sync::Mutex<mpsc::UnboundedReceiver<(u16, Vec<u8>)>>>,
}

struct VecWriter(Vec<u8>);

impl embedded_io::ErrorType for VecWriter {
    type Error = Infallible;
}

impl embedded_io::Write for VecWriter {
    fn write(&mut self, buf: &[u8]) -> Result<usize, Self::Error> {
        self.0.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> Result<(), Self::Error> {
        Ok(())
    }
}

/// `bt-hci` `Transport` backed by in-memory channels + strict `SimSdcState`.
pub struct SimHciTransport {
    state: Arc<Mutex<SimSdcState>>,
    to_host_tx: mpsc::UnboundedSender<Vec<u8>>,
    to_host_rx: tokio::sync::Mutex<mpsc::UnboundedReceiver<Vec<u8>>>,
    att_out_tx: mpsc::UnboundedSender<(u16, Vec<u8>)>,
}

pub type SimController = ExternalController<SimHciTransport, 10>;

/// Create a paired `(ExternalController<SimHciTransport, 10>, SimSdcHandle)`.
pub fn create_sim_controller(cfg: SimSdcConfig) -> (SimController, SimSdcHandle) {
    let state = Arc::new(Mutex::new(SimSdcState::new(
        cfg.max_adv_sets,
        cfg.has_public_addr,
    )));
    let (to_host_tx, to_host_rx) = mpsc::unbounded_channel();
    let (att_out_tx, att_out_rx) = mpsc::unbounded_channel();

    let transport = SimHciTransport {
        state: Arc::clone(&state),
        to_host_tx: to_host_tx.clone(),
        to_host_rx: tokio::sync::Mutex::new(to_host_rx),
        att_out_tx,
    };

    let handle = SimSdcHandle {
        state,
        to_host_tx,
        att_out_rx: Arc::new(tokio::sync::Mutex::new(att_out_rx)),
    };

    (ExternalController::new(transport), handle)
}

impl SimHciTransport {
    fn emit_cmd_complete(&self, opcode: u16, ret_params: &[u8]) {
        let mut pkt = Vec::with_capacity(6 + ret_params.len());
        pkt.push(PacketKind::Event as u8);
        pkt.push(0x0E); // CommandComplete
        pkt.push((3 + ret_params.len()) as u8);
        pkt.push(1); // num_hci_cmd_pkts
        pkt.extend_from_slice(&opcode.to_le_bytes());
        pkt.extend_from_slice(ret_params);
        let _ = self.to_host_tx.send(pkt);
    }

    fn emit_cmd_status(&self, status: u8, opcode: u16) {
        let mut pkt = Vec::with_capacity(7);
        pkt.push(PacketKind::Event as u8);
        pkt.push(0x0F); // CommandStatus
        pkt.push(4);
        pkt.push(status);
        pkt.push(1);
        pkt.extend_from_slice(&opcode.to_le_bytes());
        let _ = self.to_host_tx.send(pkt);
    }

    fn emit_event(&self, event_code: u8, params: &[u8]) {
        let mut pkt = Vec::with_capacity(3 + params.len());
        pkt.push(PacketKind::Event as u8);
        pkt.push(event_code);
        pkt.push(params.len() as u8);
        pkt.extend_from_slice(params);
        let _ = self.to_host_tx.send(pkt);
    }

    fn check_adv_mode(st: &mut SimSdcState, mode: AdvApiMode) -> Result<(), u8> {
        match st.used_adv_api {
            None => {
                st.used_adv_api = Some(mode);
                Ok(())
            }
            Some(prev) if prev == mode => Ok(()),
            Some(_) => Err(0x0C), // Command Disallowed (matches nrf-sdc check_adv_cmd)
        }
    }

    fn handle_cmd(&self, opcode: u16, params: &[u8]) {
        let mut st = self.state.lock().expect("sim state lock");
        st.cmd_log.push(opcode);

        match opcode {
            // Reset
            0x0C03 => {
                st.used_adv_api = None;
                st.default_random_addr = None;
                st.adv_sets.clear();
                st.active_connections.clear();
                self.emit_cmd_complete(opcode, &[0x00]);
            }
            // Set Event Mask / Set Event Mask Page 2 / Host Buffer Size / LE Set Event Mask / LE Set RPA Timeout
            0x0C01 | 0x0C63 | 0x0C33 | 0x2001 | 0x202D => {
                self.emit_cmd_complete(opcode, &[0x00]);
            }
            // Read BD_ADDR
            0x1009 => {
                let addr = if st.has_public_addr {
                    [0x10, 0x20, 0x30, 0x40, 0x50, 0x60]
                } else {
                    [0u8; 6]
                };
                let mut ret = [0u8; 7];
                ret[0] = 0x00;
                ret[1..7].copy_from_slice(&addr);
                self.emit_cmd_complete(opcode, &ret);
            }
            // LE Read Buffer Size
            0x2002 => {
                let mut ret = [0u8; 4];
                ret[0] = 0x00;
                ret[1..3].copy_from_slice(&251u16.to_le_bytes());
                ret[3] = 8; // total_num_le_acl_data_packets
                self.emit_cmd_complete(opcode, &ret);
            }
            // LE Read Filter Accept List Size
            0x200F => {
                self.emit_cmd_complete(opcode, &[0x00, 8]);
            }
            // LE Rand
            0x2018 => {
                self.emit_cmd_complete(
                    opcode,
                    &[0x00, 0xA1, 0xB2, 0xC3, 0xD4, 0xE5, 0xF6, 0x07, 0x18],
                );
            }
            // LE Set Random Address
            0x2005 => {
                if params.len() < 6 {
                    self.emit_cmd_complete(opcode, &[0x12]);
                    return;
                }
                let mut addr = [0u8; 6];
                addr.copy_from_slice(&params[..6]);
                st.default_random_addr = Some(addr);
                self.emit_cmd_complete(opcode, &[0x00]);
            }
            // LE Set Host Feature (optional)
            0x2074 => {
                self.emit_cmd_complete(opcode, &[0x01]); // Unknown HCI Command (gracefully ignored)
            }
            // LE Read Number of Supported Advertising Sets
            0x203B => {
                if let Err(code) = Self::check_adv_mode(&mut st, AdvApiMode::Extended) {
                    self.emit_cmd_complete(opcode, &[code, 0]);
                    return;
                }
                let max_sets = st.max_adv_sets;
                self.emit_cmd_complete(opcode, &[0x00, max_sets]);
            }
            // LE Read Max Adv Data Length
            0x203A => {
                let mut ret = [0u8; 3];
                ret[0] = 0x00;
                ret[1..3].copy_from_slice(&1650u16.to_le_bytes());
                self.emit_cmd_complete(opcode, &ret);
            }
            // LE Clear Advertising Sets
            0x203D => {
                if let Err(code) = Self::check_adv_mode(&mut st, AdvApiMode::Extended) {
                    self.emit_cmd_complete(opcode, &[code]);
                    return;
                }
                st.adv_sets.clear();
                self.emit_cmd_complete(opcode, &[0x00]);
            }
            // LE Remove Advertising Set
            0x203C => {
                if let Err(code) = Self::check_adv_mode(&mut st, AdvApiMode::Extended) {
                    self.emit_cmd_complete(opcode, &[code]);
                    return;
                }
                if params.is_empty() {
                    self.emit_cmd_complete(opcode, &[0x12]);
                    return;
                }
                st.adv_sets.remove(&params[0]);
                self.emit_cmd_complete(opcode, &[0x00]);
            }
            // LE Set Extended Advertising Parameters
            0x2036 => {
                if let Err(code) = Self::check_adv_mode(&mut st, AdvApiMode::Extended) {
                    self.emit_cmd_complete(opcode, &[code, 0]);
                    return;
                }
                if params.len() < 25 {
                    self.emit_cmd_complete(opcode, &[0x12, 0]);
                    return;
                }
                let handle = params[0];
                if handle >= st.max_adv_sets {
                    self.emit_cmd_complete(opcode, &[0x07, 0]); // Memory Capacity Exceeded
                    return;
                }
                let own_addr_kind = params[10];
                if own_addr_kind == 0 && !st.has_public_addr {
                    self.emit_cmd_complete(opcode, &[0x12, 0]); // Invalid HCI Command Parameters
                    return;
                }
                let props = u16::from_le_bytes([params[1], params[2]]);
                let interval_min_units =
                    u32::from_le_bytes([params[3], params[4], params[5], 0]);
                let interval_max_units =
                    u32::from_le_bytes([params[6], params[7], params[8], 0]);

                let entry = st.adv_sets.entry(handle).or_insert_with(|| AdvSetSnapshot {
                    handle,
                    ..Default::default()
                });
                entry.props = props;
                entry.interval_min_units = interval_min_units;
                entry.interval_max_units = interval_max_units;
                entry.own_addr_kind = own_addr_kind;

                self.emit_cmd_complete(opcode, &[0x00, 0x00]); // status=0, tx_power=0dBm
            }
            // LE Set Advertising Set Random Address
            0x2035 => {
                if let Err(code) = Self::check_adv_mode(&mut st, AdvApiMode::Extended) {
                    self.emit_cmd_complete(opcode, &[code]);
                    return;
                }
                if params.len() < 7 {
                    self.emit_cmd_complete(opcode, &[0x12]);
                    return;
                }
                let handle = params[0];
                let Some(entry) = st.adv_sets.get_mut(&handle) else {
                    self.emit_cmd_complete(opcode, &[0x42]); // Unknown Advertising Identifier
                    return;
                };
                let mut addr = [0u8; 6];
                addr.copy_from_slice(&params[1..7]);
                entry.random_addr = Some(addr);
                self.emit_cmd_complete(opcode, &[0x00]);
            }
            // LE Set Extended Advertising Data
            0x2037 => {
                if let Err(code) = Self::check_adv_mode(&mut st, AdvApiMode::Extended) {
                    self.emit_cmd_complete(opcode, &[code]);
                    return;
                }
                if params.len() < 4 {
                    self.emit_cmd_complete(opcode, &[0x12]);
                    return;
                }
                let handle = params[0];
                let data_len = params[3] as usize;
                if params.len() < 4 + data_len {
                    self.emit_cmd_complete(opcode, &[0x12]);
                    return;
                }
                let Some(entry) = st.adv_sets.get_mut(&handle) else {
                    self.emit_cmd_complete(opcode, &[0x42]);
                    return;
                };
                let is_legacy = (entry.props & 0x0010) != 0;
                if is_legacy && data_len > 31 {
                    self.emit_cmd_complete(opcode, &[0x12]);
                    return;
                }
                entry.adv_data = params[4..4 + data_len].to_vec();
                self.emit_cmd_complete(opcode, &[0x00]);
            }
            // LE Set Extended Scan Response Data
            0x2038 => {
                if let Err(code) = Self::check_adv_mode(&mut st, AdvApiMode::Extended) {
                    self.emit_cmd_complete(opcode, &[code]);
                    return;
                }
                if params.len() < 4 {
                    self.emit_cmd_complete(opcode, &[0x12]);
                    return;
                }
                let handle = params[0];
                let data_len = params[3] as usize;
                if params.len() < 4 + data_len {
                    self.emit_cmd_complete(opcode, &[0x12]);
                    return;
                }
                let Some(entry) = st.adv_sets.get_mut(&handle) else {
                    self.emit_cmd_complete(opcode, &[0x42]);
                    return;
                };
                let is_legacy = (entry.props & 0x0010) != 0;
                if is_legacy && data_len > 31 {
                    self.emit_cmd_complete(opcode, &[0x12]);
                    return;
                }
                entry.scan_data = params[4..4 + data_len].to_vec();
                self.emit_cmd_complete(opcode, &[0x00]);
            }
            // LE Set Extended Advertising Enable
            0x2039 => {
                if let Err(code) = Self::check_adv_mode(&mut st, AdvApiMode::Extended) {
                    self.emit_cmd_complete(opcode, &[code]);
                    return;
                }
                if params.len() < 2 {
                    self.emit_cmd_complete(opcode, &[0x12]);
                    return;
                }
                let enable = params[0] != 0;
                let num_sets = params[1] as usize;
                if params.len() < 2 + num_sets * 4 {
                    self.emit_cmd_complete(opcode, &[0x12]);
                    return;
                }
                if !enable && num_sets == 0 {
                    for entry in st.adv_sets.values_mut() {
                        entry.enabled = false;
                    }
                    self.emit_cmd_complete(opcode, &[0x00]);
                    return;
                }
                let mut handles_to_toggle = Vec::with_capacity(num_sets);
                for idx in 0..num_sets {
                    let adv_handle = params[2 + idx * 4];
                    let Some(entry) = st.adv_sets.get(&adv_handle) else {
                        self.emit_cmd_complete(opcode, &[0x42]);
                        return;
                    };
                    if enable && entry.own_addr_kind == 1 {
                        let Some(addr) = entry.random_addr else {
                            self.emit_cmd_complete(opcode, &[0x12]);
                            return;
                        };
                        if (addr[5] & 0xC0) != 0xC0 {
                            self.emit_cmd_complete(opcode, &[0x12]);
                            return;
                        }
                    }
                    handles_to_toggle.push(adv_handle);
                }
                for h in handles_to_toggle {
                    if let Some(entry) = st.adv_sets.get_mut(&h) {
                        entry.enabled = enable;
                    }
                }
                self.emit_cmd_complete(opcode, &[0x00]);
            }
            // Legacy advertising commands (conflict tracking)
            0x2006..=0x200A => {
                if let Err(code) = Self::check_adv_mode(&mut st, AdvApiMode::Legacy) {
                    self.emit_cmd_complete(opcode, &[code]);
                    return;
                }
                if opcode == 0x2006 && params.len() >= 6 && params[5] == 0 && !st.has_public_addr {
                    self.emit_cmd_complete(opcode, &[0x12]);
                    return;
                }
                self.emit_cmd_complete(opcode, &[0x00]);
            }
            // Disconnect
            0x0406 => {
                if params.len() < 3 {
                    self.emit_cmd_status(0x12, opcode);
                    return;
                }
                let conn_handle = u16::from_le_bytes([params[0], params[1]]) & 0x0FFF;
                let reason = params[2];
                st.active_connections.remove(&conn_handle);
                self.emit_cmd_status(0x00, opcode);
                let mut ev = [0u8; 4];
                ev[0] = 0x00;
                ev[1..3].copy_from_slice(&conn_handle.to_le_bytes());
                ev[3] = reason;
                self.emit_event(0x05, &ev);
            }
            // Read RSSI / LE Data Length / PHY update
            0x1405 | 0x2022 | 0x2032 => {
                self.emit_cmd_complete(opcode, &[0x01]);
            }
            _ => {
                self.emit_cmd_complete(opcode, &[0x01]);
            }
        }
    }

    fn handle_acl(&self, bytes: &[u8]) {
        if bytes.len() < 4 {
            return;
        }
        let conn_handle = u16::from_le_bytes([bytes[0], bytes[1]]) & 0x0FFF;
        let payload_len = u16::from_le_bytes([bytes[2], bytes[3]]) as usize;
        let payload = &bytes[4..bytes.len().min(4 + payload_len)];

        {
            let mut st = self.state.lock().expect("sim state lock");
            st.tx_acl_packets.push((conn_handle, payload.to_vec()));
        }

        if payload.len() >= 4 {
            let l2cap_len = u16::from_le_bytes([payload[0], payload[1]]) as usize;
            let cid = u16::from_le_bytes([payload[2], payload[3]]);
            if cid == 0x0004 && payload.len() >= 4 + l2cap_len {
                let att = payload[4..4 + l2cap_len].to_vec();
                let _ = self.att_out_tx.send((conn_handle, att));
            }
        }

        // Return ACL credit via NumberOfCompletedPackets (0x13)
        let mut evt = [0u8; 5];
        evt[0] = 1; // num_handles
        evt[1..3].copy_from_slice(&conn_handle.to_le_bytes());
        evt[3..5].copy_from_slice(&1u16.to_le_bytes());
        self.emit_event(0x13, &evt);
    }
}

impl embedded_io::ErrorType for SimHciTransport {
    type Error = SimTransportError;
}

impl Transport for SimHciTransport {
    async fn read<'a, P: PacketToHost<'a>>(
        &self,
        rx: &'a mut [u8],
    ) -> Result<P, Self::Error> {
        let mut guard = self.to_host_rx.lock().await;
        let pkt = guard
            .recv()
            .await
            .ok_or_else(|| SimTransportError("HCI controller closed".into()))?;
        drop(guard);

        let kind = match pkt.first().copied() {
            Some(1) => PacketKind::Cmd,
            Some(2) => PacketKind::AclData,
            Some(3) => PacketKind::SyncData,
            Some(4) => PacketKind::Event,
            Some(5) => PacketKind::IsoData,
            other => return Err(SimTransportError(format!("invalid packet kind: {other:?}"))),
        };
        let mut slice = &pkt[1..];
        P::read_hci(kind, &mut slice, rx)
            .map_err(|e| SimTransportError(format!("PacketToHost::read_hci error: {e:?}")))
    }

    async fn write<P: PacketToController>(&self, tx: &P) -> Result<(), Self::Error> {
        let mut writer = VecWriter(Vec::with_capacity(tx.size()));
        tx.write_hci(&mut writer)
            .map_err(|_| SimTransportError("VecWriter infallible".into()))?;
        let buf = writer.0;

        match P::KIND {
            PacketKind::Cmd => {
                if buf.len() < 3 {
                    return Err(SimTransportError("short HCI command".into()));
                }
                let opcode = u16::from_le_bytes([buf[0], buf[1]]);
                let plen = buf[2] as usize;
                if buf.len() < 3 + plen {
                    return Err(SimTransportError("truncated HCI command params".into()));
                }
                self.handle_cmd(opcode, &buf[3..3 + plen]);
            }
            PacketKind::AclData => {
                self.handle_acl(&buf);
            }
            _ => {}
        }
        Ok(())
    }
}

impl SimSdcHandle {
    pub fn snapshot_adv_sets(&self) -> BTreeMap<u8, AdvSetSnapshot> {
        self.state.lock().expect("sim state lock").adv_sets.clone()
    }

    pub fn cmd_log(&self) -> Vec<u16> {
        self.state.lock().expect("sim state lock").cmd_log.clone()
    }

    pub fn used_adv_api(&self) -> Option<AdvApiMode> {
        self.state.lock().expect("sim state lock").used_adv_api
    }

    /// Simulate a Central device connecting to `adv_handle` (disables ONLY `adv_handle`).
    pub fn simulate_central_connect(
        &self,
        adv_handle: u8,
        conn_handle: u16,
        peer_addr: [u8; 6],
    ) {
        {
            let mut st = self.state.lock().expect("sim state lock");
            let entry = st
                .adv_sets
                .get_mut(&adv_handle)
                .expect("adv_handle must exist");
            assert!(entry.enabled, "adv_handle {adv_handle} is not currently enabled");
            entry.enabled = false;
            st.active_connections.insert(conn_handle, adv_handle);
        }

        // 1. LE Enhanced Connection Complete (subevent 0x0A)
        let mut conn_evt = Vec::with_capacity(33);
        conn_evt.push(PacketKind::Event as u8);
        conn_evt.push(0x3E);
        conn_evt.push(31);
        conn_evt.push(0x0A); // subevent
        conn_evt.push(0x00); // status success
        conn_evt.extend_from_slice(&conn_handle.to_le_bytes());
        conn_evt.push(0x01); // role: Peripheral
        conn_evt.push(0x01); // peer_addr_kind: Random
        conn_evt.extend_from_slice(&peer_addr);
        conn_evt.extend_from_slice(&[0u8; 6]); // local RPA
        conn_evt.extend_from_slice(&[0u8; 6]); // peer RPA
        conn_evt.extend_from_slice(&12u16.to_le_bytes()); // conn_interval (15ms)
        conn_evt.extend_from_slice(&0u16.to_le_bytes()); // latency
        conn_evt.extend_from_slice(&400u16.to_le_bytes()); // supervision timeout
        conn_evt.push(0x00); // clock accuracy
        let _ = self.to_host_tx.send(conn_evt);

        // 2. LE Advertising Set Terminated (subevent 0x12)
        let mut term_evt = Vec::with_capacity(9);
        term_evt.push(PacketKind::Event as u8);
        term_evt.push(0x3E);
        term_evt.push(6);
        term_evt.push(0x12); // subevent
        term_evt.push(0x00); // status
        term_evt.push(adv_handle);
        term_evt.extend_from_slice(&conn_handle.to_le_bytes());
        term_evt.push(0); // num_completed_ext_adv_evts
        let _ = self.to_host_tx.send(term_evt);
    }

    /// Inject an incoming L2CAP ATT PDU (`CID = 0x0004`) into `trouble-host`.
    pub fn inject_att_pdu(&self, conn_handle: u16, att_pdu: &[u8]) {
        let l2cap_len = att_pdu.len() as u16;
        let acl_len = (att_pdu.len() + 4) as u16;
        let handle_pb = (conn_handle & 0x0FFF) | (0x02 << 12); // First non-automatically-flushable packet

        let mut pkt = Vec::with_capacity(9 + att_pdu.len());
        pkt.push(PacketKind::AclData as u8);
        pkt.extend_from_slice(&handle_pb.to_le_bytes());
        pkt.extend_from_slice(&acl_len.to_le_bytes());
        pkt.extend_from_slice(&l2cap_len.to_le_bytes());
        pkt.extend_from_slice(&0x0004u16.to_le_bytes()); // ATT CID
        pkt.extend_from_slice(att_pdu);
        let _ = self.to_host_tx.send(pkt);
    }

    /// Wait for the next outgoing ATT PDU transmitted by `trouble-host`.
    pub async fn wait_tx_att_pdu(&self, timeout: Duration) -> Option<(u16, Vec<u8>)> {
        let mut rx = self.att_out_rx.lock().await;
        tokio::time::timeout(timeout, rx.recv()).await.ok().flatten()
    }

    /// Simulate Central disconnecting `conn_handle`.
    pub fn simulate_disconnect(&self, conn_handle: u16, reason: u8) {
        self.state
            .lock()
            .expect("sim state lock")
            .active_connections
            .remove(&conn_handle);
        let mut pkt = Vec::with_capacity(7);
        pkt.push(PacketKind::Event as u8);
        pkt.push(0x05); // Disconnection Complete
        pkt.push(4);
        pkt.push(0x00); // status
        pkt.extend_from_slice(&conn_handle.to_le_bytes());
        pkt.push(reason);
        let _ = self.to_host_tx.send(pkt);
    }
}
