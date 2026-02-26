pub const CASIC_HEADER_1: u8 = 0xBA;
pub const CASIC_HEADER_2: u8 = 0xCE;
pub const CASIC_MAX_PAYLOAD_SIZE: usize = 256;
pub const CASIC_PACKET_TIMEOUT_MS: u64 = 30_000;

// ACK and NACK share the same class ID (0x05) per CASIC protocol spec;
// they are distinguished by message ID (ACK=0x01, NACK=0x00).
pub const CASIC_CLASS_ACK: u8 = 0x05;
pub const CASIC_CLASS_NACK: u8 = 0x05;
#[allow(dead_code)] // protocol completeness
pub const CASIC_CLASS_AID: u8 = 0x0B;
pub const CASIC_CLASS_MSG: u8 = 0x08;

pub const CASIC_ID_ACK: u8 = 0x01;
pub const CASIC_ID_NACK: u8 = 0x00;
#[allow(dead_code)] // protocol completeness
pub const CASIC_ID_AID_INI: u8 = 0x01;
#[allow(dead_code)] // protocol completeness
pub const CASIC_ID_MSG_BDSUTC: u8 = 0x00;
#[allow(dead_code)] // protocol completeness
pub const CASIC_ID_MSG_BDSION: u8 = 0x01;
pub const CASIC_ID_MSG_BDSEPH: u8 = 0x02;
#[allow(dead_code)] // protocol completeness
pub const CASIC_ID_MSG_GPSUTC: u8 = 0x05;
#[allow(dead_code)] // protocol completeness
pub const CASIC_ID_MSG_GPSION: u8 = 0x06;
pub const CASIC_ID_MSG_GPSEPH: u8 = 0x07;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CasicParserState {
    Idle,
    Header1,
    Header2,
    LenMsb,
    ClassId,
    MsgId,
    Payload,
    Checksum1,
    Checksum2,
    Checksum3,
    Checksum4,
}

#[derive(Clone, Copy, Debug)]
pub struct CasicPacket {
    pub class_id: u8,
    pub msg_id: u8,
    pub payload_length: u16,
    pub payload: [u8; CASIC_MAX_PAYLOAD_SIZE],
    pub checksum: u32,
    pub calculated_checksum: u32,
    pub valid: bool,
    pub timestamp_ms: u64,
}

impl Default for CasicPacket {
    fn default() -> Self {
        Self {
            class_id: 0,
            msg_id: 0,
            payload_length: 0,
            payload: [0; CASIC_MAX_PAYLOAD_SIZE],
            checksum: 0,
            calculated_checksum: 0,
            valid: false,
            timestamp_ms: 0,
        }
    }
}

pub struct CasicParser {
    state: CasicParserState,
    current: CasicPacket,
    last_valid: CasicPacket,
    payload_index: usize,
    checksum_bytes: [u8; 4],
    checksum_index: usize,
    state_change_ms: u64,
    new_data: bool,
}

impl CasicParser {
    pub fn new() -> Self {
        Self {
            state: CasicParserState::Idle,
            current: CasicPacket::default(),
            last_valid: CasicPacket::default(),
            payload_index: 0,
            checksum_bytes: [0; 4],
            checksum_index: 0,
            state_change_ms: 0,
            new_data: false,
        }
    }

    pub fn encode(&mut self, byte: u8, now_ms: u64) -> bool {
        if self.is_timeout(now_ms) {
            self.reset_parser(now_ms);
        }

        if self.state == CasicParserState::Idle && byte == CASIC_HEADER_1 {
            self.state = CasicParserState::Header1;
            self.state_change_ms = now_ms;
            return false;
        }

        if self.state != CasicParserState::Idle {
            return self.process_casic_byte(byte, now_ms);
        }

        false
    }

    pub fn is_new_casic_data(&self) -> bool {
        self.new_data
    }

    pub fn clear_casic_data(&mut self) {
        self.new_data = false;
    }

    pub fn last_casic_packet(&self) -> CasicPacket {
        self.last_valid
    }

    pub fn parser_state(&self) -> CasicParserState {
        self.state
    }

    pub fn reset(&mut self, now_ms: u64) {
        self.reset_parser(now_ms);
        self.new_data = false;
        self.last_valid = CasicPacket::default();
    }

    pub fn has_new_ack(&self) -> bool {
        self.new_data
            && self.last_valid.class_id == CASIC_CLASS_ACK
            && self.last_valid.msg_id == CASIC_ID_ACK
    }

    pub fn has_new_nack(&self) -> bool {
        self.new_data
            && self.last_valid.class_id == CASIC_CLASS_NACK
            && self.last_valid.msg_id == CASIC_ID_NACK
    }

    pub fn has_new_ephemeris(&self) -> bool {
        self.new_data
            && self.last_valid.class_id == CASIC_CLASS_MSG
            && (self.last_valid.msg_id == CASIC_ID_MSG_GPSEPH
                || self.last_valid.msg_id == CASIC_ID_MSG_BDSEPH)
    }

    fn process_casic_byte(&mut self, byte: u8, now_ms: u64) -> bool {
        match self.state {
            CasicParserState::Header1 => {
                if byte == CASIC_HEADER_2 {
                    self.state = CasicParserState::Header2;
                    self.state_change_ms = now_ms;
                    self.current = CasicPacket::default();
                    self.payload_index = 0;
                    self.checksum_index = 0;
                } else if byte == CASIC_HEADER_1 {
                    self.state_change_ms = now_ms;
                } else {
                    self.reset_parser(now_ms);
                }
            }
            CasicParserState::Header2 => {
                self.current.payload_length = byte as u16;
                self.state = CasicParserState::LenMsb;
                self.state_change_ms = now_ms;
            }
            CasicParserState::LenMsb => {
                self.current.payload_length |= (byte as u16) << 8;
                if self.current.payload_length as usize > CASIC_MAX_PAYLOAD_SIZE {
                    self.reset_parser(now_ms);
                    return false;
                }
                self.state = CasicParserState::ClassId;
                self.state_change_ms = now_ms;
            }
            CasicParserState::ClassId => {
                self.current.class_id = byte;
                self.state = CasicParserState::MsgId;
                self.state_change_ms = now_ms;
            }
            CasicParserState::MsgId => {
                self.current.msg_id = byte;
                self.state_change_ms = now_ms;
                if self.current.payload_length == 0 {
                    self.state = CasicParserState::Checksum1;
                } else {
                    self.state = CasicParserState::Payload;
                }
            }
            CasicParserState::Payload => {
                if self.payload_index < self.current.payload_length as usize {
                    self.current.payload[self.payload_index] = byte;
                    self.payload_index += 1;
                    self.state_change_ms = now_ms;
                    if self.payload_index >= self.current.payload_length as usize {
                        self.state = CasicParserState::Checksum1;
                    }
                }
            }
            CasicParserState::Checksum1 => {
                self.checksum_bytes[0] = byte;
                self.checksum_index = 1;
                self.state = CasicParserState::Checksum2;
                self.state_change_ms = now_ms;
            }
            CasicParserState::Checksum2 => {
                self.checksum_bytes[1] = byte;
                self.checksum_index = 2;
                self.state = CasicParserState::Checksum3;
                self.state_change_ms = now_ms;
            }
            CasicParserState::Checksum3 => {
                self.checksum_bytes[2] = byte;
                self.checksum_index = 3;
                self.state = CasicParserState::Checksum4;
                self.state_change_ms = now_ms;
            }
            CasicParserState::Checksum4 => {
                self.checksum_bytes[3] = byte;
                self.checksum_index = 4;
                self.current.checksum = (self.checksum_bytes[0] as u32)
                    | ((self.checksum_bytes[1] as u32) << 8)
                    | ((self.checksum_bytes[2] as u32) << 16)
                    | ((self.checksum_bytes[3] as u32) << 24);
                self.process_completed_packet(now_ms);
                self.reset_parser(now_ms);
                return true;
            }
            CasicParserState::Idle => {}
        }

        false
    }

    fn process_completed_packet(&mut self, now_ms: u64) {
        self.current.calculated_checksum = self.calculate_checksum();
        self.current.valid = self.current.checksum == self.current.calculated_checksum;
        if self.current.valid {
            self.current.timestamp_ms = now_ms;
            self.last_valid = self.current;
            self.new_data = true;
        }
    }

    fn calculate_checksum(&self) -> u32 {
        let mut checksum =
            ((self.current.msg_id as u32) << 24)
                + ((self.current.class_id as u32) << 16)
                + (self.current.payload_length as u32);

        // CASIC protocol guarantees payload_length is always a multiple of 4 bytes.
        let words = (self.current.payload_length as usize) / 4;
        for i in 0..words {
            let base = i * 4;
            let word = (self.current.payload[base] as u32)
                | ((self.current.payload[base + 1] as u32) << 8)
                | ((self.current.payload[base + 2] as u32) << 16)
                | ((self.current.payload[base + 3] as u32) << 24);
            checksum = checksum.wrapping_add(word);
        }
        checksum
    }

    fn reset_parser(&mut self, now_ms: u64) {
        self.state = CasicParserState::Idle;
        self.payload_index = 0;
        self.checksum_index = 0;
        self.state_change_ms = now_ms;
        self.current = CasicPacket::default();
    }

    fn is_timeout(&self, now_ms: u64) -> bool {
        if self.state == CasicParserState::Idle {
            return false;
        }
        now_ms.saturating_sub(self.state_change_ms) > CASIC_PACKET_TIMEOUT_MS
    }
}
