MEMORY
{
  /* No SoftDevice blob — Flash starts at 0 */
  FLASH : ORIGIN = 0x00000000, LENGTH = 1024K

  /* No SoftDevice RAM reservation — SDC uses sdc::Mem<N> in user memory */
  RAM : ORIGIN = 0x20000000, LENGTH = 256K
}
