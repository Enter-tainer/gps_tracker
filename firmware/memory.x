MEMORY
{
  /* Keep 0x00000000..0x00027000 untouched (MBR + S140 header for Adafruit UF2 Bootloader)
     and stop at 0x000F4000 so we never overwrite the Adafruit UF2 Bootloader! */
  FLASH : ORIGIN = 0x00027000, LENGTH = 0x000F4000 - 0x00027000

  /* Reserve first 1 KB (0x20000000..0x20000400) for MBR boot stack/forwarding;
     S140 is no longer enabled so remaining 255 KB RAM is available to the app + nrf-sdc. */
  RAM : ORIGIN = 0x20000400, LENGTH = 256K - 0x400
}
