/**
 * 应用程序常量定义
 */
export const CONSTANTS = {
  // 蓝牙服务和特性 UUID
  BLE: {
    UART_SERVICE_UUID: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
    UART_TX_CHARACTERISTIC_UUID: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
    UART_RX_CHARACTERISTIC_UUID: '6e400003-b5a3-f393-e0a9-e50e24dcca9e'
  },
  
  // 协议命令 ID
  CMD_ID: {
    LIST_DIR: 0x01,
    OPEN_FILE: 0x02,
    READ_CHUNK: 0x03,
    CLOSE_FILE: 0x04,
    DELETE_FILE: 0x05,
    GET_SYS_INFO: 0x06,
    START_AGNSS_WRITE: 0x07,
    WRITE_AGNSS_CHUNK: 0x08,
    END_AGNSS_WRITE: 0x09
  },
  
  // 文件系统条目类型
  ENTRY_TYPE: { 
    FILE: 0x00, 
    DIRECTORY: 0x01 
  },
  
  // 系统信息有效载荷长度
  SYSINFO_PAYLOAD_LEN: 50,
  
  // MTU 默认值
  DEFAULT_MTU_SIZE: 23
};

/**
 * 辅助常量和枚举
 */
export const UI_ELEMENTS = {
  CONNECT_BUTTON: 'connectButton',
  LIST_DIR_BUTTON: 'listDirButton',
  FILE_LIST_DIV: 'fileList',
  MESSAGES_DIV: 'messages',
  STATUS_DIV: 'status',
  CURRENT_PATH_INPUT: 'currentPath',
  SYS_INFO_BUTTON: 'sysInfoButton',
  AGNSS_BUTTON: 'agnssButton',
  AGNSS_STATUS: 'agnssStatus',
  GPX_VIEWER: 'gpxViewer'
};