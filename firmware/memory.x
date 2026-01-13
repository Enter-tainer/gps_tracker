MEMORY
{
  /* S140 7.3.0 occupies up to 0x00026498, round up to 0x00027000 */
  FLASH : ORIGIN = 0x00027000, LENGTH = 1024K - 0x27000

  /* Reserve 0x3000 RAM for SoftDevice by default */
  RAM : ORIGIN = 0x20003000, LENGTH = 256K - 0x3000
}
