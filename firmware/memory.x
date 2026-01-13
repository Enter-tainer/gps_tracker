/* memory.x */
MEMORY
{
  /* No SoftDevice: app starts at 0x00000000 */
  FLASH : ORIGIN = 0x00000000, LENGTH = 1024K

  /* No SoftDevice: full RAM available */
  RAM : ORIGIN = 0x20000000, LENGTH = 256K
}
