/* memory.x */
MEMORY
{
  /* S140 v7.x.x 大约占用 152KB Flash (0x26000) */
  /* 应用代码从 0x26000 开始 */
  FLASH : ORIGIN = 0x00026000, LENGTH = 1024K - 0x26000

  /* SoftDevice 也占用一部分 RAM，具体取决于蓝牙配置 */
  /* 这里预留 0x3000 (12KB) 给 SoftDevice，通常够用 */
  /* 如果运行时报错 "softdevice RAM check failed"，你需要增大 ORIGIN 并减小 LENGTH */
  RAM : ORIGIN = 0x20003000, LENGTH = 256K - 0x3000
}
