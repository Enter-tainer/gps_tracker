use embassy_nrf::{peripherals, Peri};

pub struct Board {
    pub led: Peri<'static, peripherals::P0_15>,
    pub button: Peri<'static, peripherals::P1_00>,
    pub gps_uart_rx: Peri<'static, peripherals::P0_22>,
    pub gps_uart_tx: Peri<'static, peripherals::P0_20>,
    pub gps_en: Peri<'static, peripherals::P0_24>,
    pub i2c_sda: Peri<'static, peripherals::P1_04>,
    pub i2c_scl: Peri<'static, peripherals::P0_11>,
    pub spi_miso: Peri<'static, peripherals::P0_02>,
    pub spi_mosi: Peri<'static, peripherals::P1_15>,
    pub spi_sck: Peri<'static, peripherals::P1_11>,
    pub spi_cs: Peri<'static, peripherals::P1_13>,
    pub battery_adc: Peri<'static, peripherals::P0_31>,
    pub v3v3_en: Peri<'static, peripherals::P0_13>,
    pub serial2_rx: Peri<'static, peripherals::P0_06>,
    pub serial2_tx: Peri<'static, peripherals::P0_08>,
    pub uarte0: Peri<'static, peripherals::UARTE0>,
    pub twispi0: Peri<'static, peripherals::TWISPI0>,
    pub spi3: Peri<'static, peripherals::SPI3>,
    pub saadc: Peri<'static, peripherals::SAADC>,
    pub timer1: Peri<'static, peripherals::TIMER1>,
    pub ppi_ch8: Peri<'static, peripherals::PPI_CH8>,
    pub ppi_ch9: Peri<'static, peripherals::PPI_CH9>,
    pub ppi_group1: Peri<'static, peripherals::PPI_GROUP1>,
}

impl Board {
    pub fn new(p: embassy_nrf::Peripherals) -> Self {
        Self {
            led: p.P0_15,
            button: p.P1_00,
            gps_uart_rx: p.P0_22,
            gps_uart_tx: p.P0_20,
            gps_en: p.P0_24,
            i2c_sda: p.P1_04,
            i2c_scl: p.P0_11,
            spi_miso: p.P0_02,
            spi_mosi: p.P1_15,
            spi_sck: p.P1_11,
            spi_cs: p.P1_13,
            battery_adc: p.P0_31,
            v3v3_en: p.P0_13,
            serial2_rx: p.P0_06,
            serial2_tx: p.P0_08,
            uarte0: p.UARTE0,
            twispi0: p.TWISPI0,
            spi3: p.SPI3,
            saadc: p.SAADC,
            timer1: p.TIMER1,
            ppi_ch8: p.PPI_CH8,
            ppi_ch9: p.PPI_CH9,
            ppi_group1: p.PPI_GROUP1,
        }
    }
}
