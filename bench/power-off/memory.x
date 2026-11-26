MEMORY
{
  /* 0x00000000..0x00027000 是 MBR + Adafruit UF2 bootloader 的头部，不能碰；
     0x000F4000 以上是 UF2 bootloader 本体，也不能碰。 */
  FLASH : ORIGIN = 0x00027000, LENGTH = 0x000F4000 - 0x00027000

  /* MBR 转发时用掉前 1 KB，其余留给应用。 */
  RAM : ORIGIN = 0x20000400, LENGTH = 256K - 0x400
}
