use core::borrow::BorrowMut;
use core::cmp::min;

use defmt::warn;
use embassy_executor::task;
use embassy_futures::select::{select, Either};
use embassy_nrf::peripherals;
use embassy_nrf::usb::vbus_detect::{SoftwareVbusDetect, VbusDetect};
use embassy_nrf::Peri;
use embassy_time::Timer;
use embedded_sdmmc::{Block, BlockDevice, BlockIdx};
use nrf_pac as pac;
use nrf_usbd::Usbd;
use static_cell::StaticCell;
use usb_device::class_prelude::*;
use usb_device::prelude::*;
use usb_device::UsbError;
use usbd_storage::subclass::scsi::{Scsi, ScsiCommand};
use usbd_storage::subclass::Command;
use usbd_storage::transport::bbb::{BulkOnly, BulkOnlyError};
use usbd_storage::transport::TransportError;

use crate::storage;

const USB_VID: u16 = 0xCAFE;
const USB_PID: u16 = 0x4001;
const MAX_PACKET_SIZE: u16 = 64;
const MSC_BUFFER_SIZE: usize = 512;
const USB_POWER_READY_TIMEOUT_MS: u64 = 200;
const USB_HFCLK_POLL_MS: u64 = 1;
const READ_AHEAD_BLOCKS: usize = 8;

const SENSE_KEY_NO_SENSE: u8 = 0x00;
const SENSE_KEY_NOT_READY: u8 = 0x02;
const SENSE_KEY_MEDIUM_ERROR: u8 = 0x03;
const SENSE_KEY_ILLEGAL_REQUEST: u8 = 0x05;

const ASC_NO_ADDITIONAL_SENSE: u8 = 0x00;
const ASC_INVALID_COMMAND: u8 = 0x20;
const ASC_LBA_OUT_OF_RANGE: u8 = 0x21;
const ASC_MEDIUM_NOT_PRESENT: u8 = 0x3A;
const ASC_WRITE_FAULT: u8 = 0x03;

const SCSI_CMD_START_STOP_UNIT: u8 = 0x1B;
const SCSI_CMD_PREVENT_ALLOW_MEDIUM_REMOVAL: u8 = 0x1E;
const SCSI_CMD_VERIFY_10: u8 = 0x2F;
const SCSI_CMD_SYNCHRONIZE_CACHE: u8 = 0x35;

static USB_BUS: StaticCell<UsbBusAllocator<Usbd<UsbdPeripheral>>> = StaticCell::new();
static USB_VBUS: StaticCell<SoftwareVbusDetect> = StaticCell::new();
static USB_BUF: StaticCell<[u8; MSC_BUFFER_SIZE]> = StaticCell::new();

struct UsbdPeripheral {
    _periph: Peri<'static, peripherals::USBD>,
}

impl UsbdPeripheral {
    fn new(periph: Peri<'static, peripherals::USBD>) -> Self {
        Self { _periph: periph }
    }
}

unsafe impl nrf_usbd::UsbPeripheral for UsbdPeripheral {
    const REGISTERS: *const () = pac::USBD.as_ptr() as *const ();
}

pub fn init_vbus() -> &'static SoftwareVbusDetect {
    USB_VBUS.init(SoftwareVbusDetect::new(false, false))
}

async fn wait_hfclk_running() {
    let clock = unsafe { &*pac::CLOCK::PTR };
    clock
        .tasks_hfclkstart()
        .write(|w| w.set_tasks_hfclkstart(true));
    loop {
        if clock.events_hfclkstarted().read().bits() != 0 {
            clock.events_hfclkstarted().write(|w| w.bits(0));
            break;
        }
        Timer::after_millis(USB_HFCLK_POLL_MS).await;
    }
}

#[task]
pub async fn usb_msc_task(usbd: Peri<'static, peripherals::USBD>, vbus: &'static SoftwareVbusDetect) {
    defmt::info!("USB MSC task start");
    let usb_bus = USB_BUS.init(UsbBusAllocator::new(Usbd::new(UsbdPeripheral::new(usbd))));
    let mut usb_buf = Some(USB_BUF.init([0; MSC_BUFFER_SIZE]) as &'static mut [u8]);
    let mut scsi = None;
    let mut usb_dev = None;

    let mut vbus = vbus; // mut required: wait_power_ready() takes &mut self
    let mut state = MscState::new();

    loop {
        match select(vbus.wait_power_ready(), Timer::after_millis(USB_POWER_READY_TIMEOUT_MS)).await
        {
            Either::First(Ok(())) => {}
            Either::First(Err(())) => {
                Timer::after_millis(50).await;
                continue;
            }
            Either::Second(()) => {
                if !vbus.is_usb_detected() {
                    continue;
                }
            }
        }

        defmt::info!("USB power ready");
        wait_hfclk_running().await;

        if usb_dev.is_none() {
            let buf = usb_buf.take().unwrap();
            let scsi_instance = Scsi::new(usb_bus, MAX_PACKET_SIZE, 0, buf).unwrap();
            let usb_dev_instance = UsbDeviceBuilder::new(usb_bus, UsbVidPid(USB_VID, USB_PID))
                .strings(&[StringDescriptors::new(LangID::EN_US)
                    .manufacturer("GPS Tracker")
                    .product("GPS Tracker SD")
                    .serial_number("0001")])
                .unwrap()
                .device_class(0x00)
                .device_sub_class(0x00)
                .device_protocol(0x00)
                .max_packet_size_0(MAX_PACKET_SIZE as u8)
                .unwrap()
                .build();
            scsi = Some(scsi_instance);
            usb_dev = Some(usb_dev_instance);
        }

        let scsi = scsi.as_mut().unwrap();
        let usb_dev = usb_dev.as_mut().unwrap();

        let ok = storage::enter_usb_mode().await;
        if ok {
            defmt::info!("USB mode storage ready");
        } else {
            defmt::warn!("USB mode storage not ready");
        }
        state.reset();
        let _ = usb_dev.force_reset();
        while vbus.is_usb_detected() {
            if usb_dev.poll(&mut [scsi]) {
                if let Err(err) = scsi.poll(|cmd| handle_scsi_command(cmd, &mut state)) {
                    log_usb_error("scsi.poll", err);
                }
            } else {
                Timer::after_micros(50).await;
            }
        }

        let _ = storage::exit_usb_mode().await;
    }
}

#[derive(Clone, Copy)]
struct SenseData {
    key: u8,
    asc: u8,
    ascq: u8,
}

impl SenseData {
    const fn new() -> Self {
        Self {
            key: SENSE_KEY_NO_SENSE,
            asc: ASC_NO_ADDITIONAL_SENSE,
            ascq: 0,
        }
    }

    fn set(&mut self, key: u8, asc: u8, ascq: u8) {
        self.key = key;
        self.asc = asc;
        self.ascq = ascq;
    }

    fn clear(&mut self) {
        self.set(SENSE_KEY_NO_SENSE, ASC_NO_ADDITIONAL_SENSE, 0);
    }

    fn as_bytes(&self) -> [u8; 18] {
        let mut data = [0u8; 18];
        data[0] = 0x70;
        data[2] = self.key;
        data[7] = 10;
        data[12] = self.asc;
        data[13] = self.ascq;
        data
    }
}

struct MscState {
    sense: SenseData,
    transfer: Option<Transfer>,
}

enum Transfer {
    Read(ReadTransfer),
    Write(WriteTransfer),
}

struct ReadTransfer {
    lba: u32,
    blocks_left: u32,
    cache: [Block; READ_AHEAD_BLOCKS],
    cache_blocks: usize,
    cache_index: usize,
    block_offset: usize,
}

struct WriteTransfer {
    lba: u32,
    blocks_left: u32,
    block: Block,
    block_offset: usize,
}

impl MscState {
    fn new() -> Self {
        Self {
            sense: SenseData::new(),
            transfer: None,
        }
    }

    fn reset(&mut self) {
        self.sense.clear();
        self.transfer = None;
    }
}

fn handle_scsi_command<Bus, Buf>(
    mut cmd: Command<ScsiCommand, Scsi<BulkOnly<'_, Bus, Buf>>>,
    state: &mut MscState,
)
where
    Bus: UsbBus,
    Buf: BorrowMut<[u8]>,
{
    if cmd.lun != 0 {
        warn!("Invalid LUN: {}", cmd.lun);
        fail_with_sense(state, cmd, SENSE_KEY_ILLEGAL_REQUEST, ASC_INVALID_COMMAND, 0);
        return;
    }

    match cmd.kind {
        ScsiCommand::Inquiry {
            evpd,
            page_code,
            alloc_len,
        } => {
            let alloc_len = alloc_len as usize;
            if evpd {
                match page_code {
                    0x00 => {
                        const VPD_PAGES: [u8; 2] = [0x00, 0x80];
                        let mut data = [0u8; 6];
                        data[1] = 0x00;
                        data[3] = VPD_PAGES.len() as u8;
                        data[4..].copy_from_slice(&VPD_PAGES);
                        if !write_scsi_response(cmd, state, &data, alloc_len, "inquiry_vpd0")
                        {
                            return;
                        }
                    }
                    0x80 => {
                        const SERIAL: [u8; 4] = *b"0001";
                        let mut data = [0u8; 8];
                        data[1] = 0x80;
                        data[3] = SERIAL.len() as u8;
                        data[4..].copy_from_slice(&SERIAL);
                        if !write_scsi_response(cmd, state, &data, alloc_len, "inquiry_vpd80")
                        {
                            return;
                        }
                    }
                    _ => {
                        fail_with_sense(state, cmd, SENSE_KEY_ILLEGAL_REQUEST, ASC_INVALID_COMMAND, 0);
                    }
                }
                return;
            }

            let mut data = [0u8; 36];
            data[0] = 0x00;
            data[1] = 0x80;
            data[2] = 0x05;
            data[3] = 0x02;
            data[4] = 31;
            data[8..16].copy_from_slice(b"GPS     ");
            data[16..32].copy_from_slice(b"TRACKER SD CARD ");
            data[32..36].copy_from_slice(b"1.00");
            if !write_scsi_response(cmd, state, &data, alloc_len, "inquiry") {
                return;
            }
        }
        ScsiCommand::TestUnitReady => {
            if num_blocks().is_some() {
                cmd.pass();
            } else {
                fail_with_sense(state, cmd, SENSE_KEY_NOT_READY, ASC_MEDIUM_NOT_PRESENT, 0);
            }
        }
        ScsiCommand::RequestSense { alloc_len, .. } => {
            let alloc_len = alloc_len as usize;
            let data = state.sense.as_bytes();
            if write_scsi_response(cmd, state, &data, alloc_len, "request_sense") {
                state.sense.clear();
            }
        }
        ScsiCommand::ModeSense6 { alloc_len, .. } => {
            let alloc_len = alloc_len as usize;
            let data = [3, 0, 0, 0];
            let _ = write_scsi_response(cmd, state, &data, alloc_len, "modesense6");
        }
        ScsiCommand::ModeSense10 { alloc_len, .. } => {
            let alloc_len = alloc_len as usize;
            let data = [0, 6, 0, 0, 0, 0, 0, 0];
            let _ = write_scsi_response(cmd, state, &data, alloc_len, "modesense10");
        }
        ScsiCommand::ReadCapacity10 => {
            let Some(blocks) = num_blocks() else {
                fail_with_sense(state, cmd, SENSE_KEY_NOT_READY, ASC_MEDIUM_NOT_PRESENT, 0);
                return;
            };
            if blocks == 0 {
                fail_with_sense(state, cmd, SENSE_KEY_NOT_READY, ASC_MEDIUM_NOT_PRESENT, 0);
                return;
            }
            let last_block = blocks - 1;
            let mut data = [0u8; 8];
            data[..4].copy_from_slice(&last_block.to_be_bytes());
            data[4..8].copy_from_slice(&Block::LEN_U32.to_be_bytes());
            if cmd.write_data(&data).is_err() {
                fail_with_sense(state, cmd, SENSE_KEY_MEDIUM_ERROR, ASC_WRITE_FAULT, 0);
                return;
            }
            cmd.pass();
        }
        ScsiCommand::ReadCapacity16 { alloc_len } => {
            let alloc_len = alloc_len as usize;
            let Some(blocks) = num_blocks() else {
                fail_with_sense(state, cmd, SENSE_KEY_NOT_READY, ASC_MEDIUM_NOT_PRESENT, 0);
                return;
            };
            if blocks == 0 {
                fail_with_sense(state, cmd, SENSE_KEY_NOT_READY, ASC_MEDIUM_NOT_PRESENT, 0);
                return;
            }
            let last_block = (blocks - 1) as u64;
            let mut data = [0u8; 32];
            data[..8].copy_from_slice(&last_block.to_be_bytes());
            data[8..12].copy_from_slice(&Block::LEN_U32.to_be_bytes());
            let _ = write_scsi_response(cmd, state, &data, alloc_len, "read_capacity16");
        }
        ScsiCommand::ReadFormatCapacities { alloc_len } => {
            let alloc_len = alloc_len as usize;
            let Some(blocks) = num_blocks() else {
                fail_with_sense(state, cmd, SENSE_KEY_NOT_READY, ASC_MEDIUM_NOT_PRESENT, 0);
                return;
            };
            let mut data = [0u8; 12];
            data[3] = 8;
            data[4..8].copy_from_slice(&blocks.to_be_bytes());
            data[8] = 0x02;
            let block_len = Block::LEN_U32.to_be_bytes();
            data[9] = block_len[1];
            data[10] = block_len[2];
            data[11] = block_len[3];
            let _ = write_scsi_response(cmd, state, &data, alloc_len, "read_format_caps");
        }
        ScsiCommand::Read { lba, len } => handle_read(cmd, state, lba, len),
        ScsiCommand::Write { lba, len } => handle_write(cmd, state, lba, len),
        ScsiCommand::Unknown { cmd: raw_cmd } => match raw_cmd {
            SCSI_CMD_START_STOP_UNIT
            | SCSI_CMD_PREVENT_ALLOW_MEDIUM_REMOVAL
            | SCSI_CMD_VERIFY_10
            | SCSI_CMD_SYNCHRONIZE_CACHE => {
                cmd.pass();
            }
            _ => {
                fail_with_sense(state, cmd, SENSE_KEY_ILLEGAL_REQUEST, ASC_INVALID_COMMAND, 0);
            }
        },
        _ => {
            fail_with_sense(state, cmd, SENSE_KEY_ILLEGAL_REQUEST, ASC_INVALID_COMMAND, 0);
        }
    }
}

fn handle_read<Bus, Buf>(
    mut cmd: Command<ScsiCommand, Scsi<BulkOnly<'_, Bus, Buf>>>,
    state: &mut MscState,
    lba: LbaType,
    len: LenType,
)
where
    Bus: UsbBus,
    Buf: BorrowMut<[u8]>,
{
    let Some((lba, blocks)) = normalize_transfer(lba, len) else {
        warn!("Read normalize_transfer failed");
        fail_with_sense(state, cmd, SENSE_KEY_ILLEGAL_REQUEST, ASC_LBA_OUT_OF_RANGE, 0);
        return;
    };
    if blocks == 0 {
        state.transfer = None;
        cmd.pass();
        return;
    }

    let total_blocks = match num_blocks() {
        Some(total) => total,
        None => {
            fail_with_sense(state, cmd, SENSE_KEY_NOT_READY, ASC_MEDIUM_NOT_PRESENT, 0);
            return;
        }
    };
    if lba.saturating_add(blocks) > total_blocks {
        fail_with_sense(state, cmd, SENSE_KEY_ILLEGAL_REQUEST, ASC_LBA_OUT_OF_RANGE, 0);
        return;
    }

    if state.transfer.is_none() {
        state.transfer = Some(Transfer::Read(ReadTransfer {
            lba,
            blocks_left: blocks,
            cache: core::array::from_fn(|_| Block::new()),
            cache_blocks: 0,
            cache_index: 0,
            block_offset: 0,
        }));
    }

    let Some(Transfer::Read(transfer)) = state.transfer.as_mut() else {
        state.transfer = None;
        fail_with_sense(state, cmd, SENSE_KEY_ILLEGAL_REQUEST, ASC_INVALID_COMMAND, 0);
        return;
    };

    while transfer.blocks_left > 0 {
        if transfer.block_offset == 0 && transfer.cache_index >= transfer.cache_blocks {
            let to_read = min(transfer.blocks_left as usize, READ_AHEAD_BLOCKS);
            if !read_blocks(transfer.lba, &mut transfer.cache[..to_read]) {
                warn!("Read blocks failed lba={}", transfer.lba);
                state.transfer = None;
                fail_with_sense(state, cmd, SENSE_KEY_NOT_READY, ASC_MEDIUM_NOT_PRESENT, 0);
                return;
            }
            transfer.cache_blocks = to_read;
            transfer.cache_index = 0;
        }

        let remaining = Block::LEN - transfer.block_offset;
        let block = &transfer.cache[transfer.cache_index];
        let written = match cmd.write_data(&block.contents[transfer.block_offset..]) {
            Ok(count) => count,
            Err(err) => {
                log_transport_error("read.write_data", err);
                state.transfer = None;
                fail_with_sense(state, cmd, SENSE_KEY_MEDIUM_ERROR, ASC_WRITE_FAULT, 0);
                return;
            }
        };
        if written == 0 {
            break;
        }

        transfer.block_offset += written;
        if transfer.block_offset >= Block::LEN {
            transfer.block_offset = 0;
            transfer.lba = transfer.lba.saturating_add(1);
            transfer.blocks_left = transfer.blocks_left.saturating_sub(1);
            transfer.cache_index = transfer.cache_index.saturating_add(1);
        }
        if written < remaining {
            break;
        }
    }

    if transfer.blocks_left == 0 && transfer.block_offset == 0 {
        state.transfer = None;
        cmd.pass();
    }
}

fn handle_write<Bus, Buf>(
    mut cmd: Command<ScsiCommand, Scsi<BulkOnly<'_, Bus, Buf>>>,
    state: &mut MscState,
    lba: LbaType,
    len: LenType,
)
where
    Bus: UsbBus,
    Buf: BorrowMut<[u8]>,
{
    let Some((lba, blocks)) = normalize_transfer(lba, len) else {
        warn!("Write normalize_transfer failed");
        fail_with_sense(state, cmd, SENSE_KEY_ILLEGAL_REQUEST, ASC_LBA_OUT_OF_RANGE, 0);
        return;
    };
    if blocks == 0 {
        state.transfer = None;
        cmd.pass();
        return;
    }

    let total_blocks = match num_blocks() {
        Some(total) => total,
        None => {
            fail_with_sense(state, cmd, SENSE_KEY_NOT_READY, ASC_MEDIUM_NOT_PRESENT, 0);
            return;
        }
    };
    if lba.saturating_add(blocks) > total_blocks {
        fail_with_sense(state, cmd, SENSE_KEY_ILLEGAL_REQUEST, ASC_LBA_OUT_OF_RANGE, 0);
        return;
    }

    if state.transfer.is_none() {
        state.transfer = Some(Transfer::Write(WriteTransfer {
            lba,
            blocks_left: blocks,
            block: Block::new(),
            block_offset: 0,
        }));
    }

    let Some(Transfer::Write(transfer)) = state.transfer.as_mut() else {
        state.transfer = None;
        fail_with_sense(state, cmd, SENSE_KEY_ILLEGAL_REQUEST, ASC_INVALID_COMMAND, 0);
        return;
    };

    while transfer.blocks_left > 0 {
        let remaining = Block::LEN - transfer.block_offset;
        let read = match cmd.read_data(&mut transfer.block.contents[transfer.block_offset..]) {
            Ok(count) => count,
            Err(err) => {
                log_transport_error("write.read_data", err);
                state.transfer = None;
                fail_with_sense(state, cmd, SENSE_KEY_MEDIUM_ERROR, ASC_WRITE_FAULT, 0);
                return;
            }
        };
        if read == 0 {
            break;
        }

        transfer.block_offset += read;
        if transfer.block_offset >= Block::LEN {
            if !write_block(transfer.lba, &transfer.block) {
                warn!("Write block failed lba={}", transfer.lba);
                state.transfer = None;
                fail_with_sense(state, cmd, SENSE_KEY_MEDIUM_ERROR, ASC_WRITE_FAULT, 0);
                return;
            }
            transfer.block_offset = 0;
            transfer.lba = transfer.lba.saturating_add(1);
            transfer.blocks_left = transfer.blocks_left.saturating_sub(1);
        }
        if read < remaining {
            break;
        }
    }

    if transfer.blocks_left == 0 && transfer.block_offset == 0 {
        state.transfer = None;
        cmd.pass();
    }
}

fn fail_with_sense<Bus, Buf>(
    state: &mut MscState,
    cmd: Command<ScsiCommand, Scsi<BulkOnly<'_, Bus, Buf>>>,
    key: u8,
    asc: u8,
    ascq: u8,
)
where
    Bus: UsbBus,
    Buf: BorrowMut<[u8]>,
{
    warn!("SCSI fail sense key={} asc={} ascq={}", key, asc, ascq);
    state.sense.set(key, asc, ascq);
    state.transfer = None;
    cmd.fail();
}

fn write_scsi_response<Bus, Buf>(
    mut cmd: Command<ScsiCommand, Scsi<BulkOnly<'_, Bus, Buf>>>,
    state: &mut MscState,
    payload: &[u8],
    alloc_len: usize,
    context: &'static str,
) -> bool
where
    Bus: UsbBus,
    Buf: BorrowMut<[u8]>,
{
    if alloc_len == 0 {
        cmd.pass();
        return true;
    }

    let mut buffer = [0u8; MSC_BUFFER_SIZE];
    let write_len = min(alloc_len, buffer.len());
    let copy_len = min(payload.len(), write_len);
    buffer[..copy_len].copy_from_slice(&payload[..copy_len]);

    match cmd.write_data(&buffer[..write_len]) {
        Ok(_) => {
            cmd.pass();
            true
        }
        Err(err) => {
            log_transport_error(context, err);
            fail_with_sense(state, cmd, SENSE_KEY_MEDIUM_ERROR, ASC_WRITE_FAULT, 0);
            false
        }
    }
}

fn log_transport_error(context: &'static str, err: TransportError<BulkOnlyError>) {
    match err {
        TransportError::Usb(err) => log_usb_error(context, err),
        TransportError::Error(err) => log_bbb_error(context, err),
    }
}

fn log_bbb_error(context: &'static str, err: BulkOnlyError) {
    match err {
        BulkOnlyError::IoBufferOverflow => warn!("{}: BBB IoBufferOverflow", context),
        BulkOnlyError::InvalidMaxLun => warn!("{}: BBB InvalidMaxLun", context),
        BulkOnlyError::InvalidState => warn!("{}: BBB InvalidState", context),
        BulkOnlyError::FullPacketExpected => warn!("{}: BBB FullPacketExpected", context),
        BulkOnlyError::BufferTooSmall => warn!("{}: BBB BufferTooSmall", context),
    }
}

fn log_usb_error(context: &'static str, err: UsbError) {
    match err {
        UsbError::WouldBlock => {}
        UsbError::ParseError => warn!("{}: USB ParseError", context),
        UsbError::BufferOverflow => warn!("{}: USB BufferOverflow", context),
        UsbError::EndpointOverflow => warn!("{}: USB EndpointOverflow", context),
        UsbError::EndpointMemoryOverflow => warn!("{}: USB EndpointMemoryOverflow", context),
        UsbError::InvalidEndpoint => warn!("{}: USB InvalidEndpoint", context),
        UsbError::Unsupported => warn!("{}: USB Unsupported", context),
        UsbError::InvalidState => warn!("{}: USB InvalidState", context),
    }
}

fn num_blocks() -> Option<u32> {
    match storage::with_usb_card(|card| card.num_blocks()) {
        Some(Ok(count)) => Some(count.0),
        _ => None,
    }
}

fn read_blocks(lba: u32, blocks: &mut [Block]) -> bool {
    match storage::with_usb_card(|card| card.read(blocks, BlockIdx(lba))) {
        Some(Ok(())) => true,
        _ => false,
    }
}

fn write_block(lba: u32, block: &Block) -> bool {
    match storage::with_usb_card(|card| card.write(core::slice::from_ref(block), BlockIdx(lba))) {
        Some(Ok(())) => true,
        _ => false,
    }
}

#[cfg(feature = "extended_addressing")]
type LbaType = u64;
#[cfg(feature = "extended_addressing")]
type LenType = u32;

#[cfg(not(feature = "extended_addressing"))]
type LbaType = u32;
#[cfg(not(feature = "extended_addressing"))]
type LenType = u16;

#[cfg(feature = "extended_addressing")]
fn normalize_transfer(lba: LbaType, len: LenType) -> Option<(u32, u32)> {
    if lba > u32::MAX as u64 {
        return None;
    }
    Some((lba as u32, len))
}

#[cfg(not(feature = "extended_addressing"))]
fn normalize_transfer(lba: LbaType, len: LenType) -> Option<(u32, u32)> {
    Some((lba, len as u32))
}
