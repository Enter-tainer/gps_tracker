import asyncio
import sys
from bleak import BleakClient, BleakScanner
from bleak.exc import BleakError

# --- 配置你的设备信息和UUID ---
# 方法1: 如果你知道设备的MAC地址 (Linux/macOS/Windows可能需要管理员权限)
# DEVICE_ADDRESS = "XX:XX:XX:XX:XX:XX" # 替换成你设备的MAC地址 (nRF Connect应该能显示)
# TARGET_NAME = None # 如果有地址，可以不关心名字

# 方法2: 通过设备名称扫描 (更通用，但可能有多个同名设备)
DEVICE_ADDRESS = "DC:5C:7F:DB:49:72"
TARGET_NAME = "ProMi"  # 替换成你的设备广播名称, e.g., Bluefruit.Advertising.addName() 设置的  # 替换成你的设备广播名称, e.g., Bluefruit.Advertising.addName() 设置的
# 或者如果你的设备名是动态的，用nRF Connect确认一下当前广播名

# 服务和特性 UUIDs (与你的C++和JS代码保持一致)
UUID_SVC_FILE_TRANSFER = "4a98bdbd-e8f5-4476-a52c-8e10e5024df5"
UUID_CHR_CONTROL_POINT = "4a980001-e8f5-4476-a52c-8e10e5024df5"
UUID_CHR_DATA_TRANSFER = "4a980002-e8f5-4476-a52c-8e10e5024df5"

# 全局变量用于特性对象
control_point_char_obj = None
data_char_obj = None


# --- 回调函数 ---
def notification_handler(sender_handle: int, data: bytearray):
    """处理从数据特性接收到的通知。"""
    try:
        # 尝试解码为字符串，如果不是字符串数据，直接打印字节
        print(
            f"[DATA NOTIFY] Handle {sender_handle}: {data.decode(errors='replace')} ({data.hex()})"
        )
    except Exception as e:
        print(
            f"[DATA NOTIFY] Handle {sender_handle}: {data.hex()} (Error decoding: {e})"
        )


async def list_files(client: BleakClient):
    """发送 LIST_FILES 命令。"""
    if not client.is_connected:
        print("Not connected.")
        return
    if not control_point_char_obj:
        print("Control Point characteristic not found.")
        return

    print("\nSending LIST_FILES (0x01) command...")
    try:
        await client.write_gatt_char(
            control_point_char_obj.uuid, b"\x01", response=False
        )  # Write w/o response
        print(
            "LIST_FILES command sent. Expecting notifications on data characteristic..."
        )
        # 等待一段时间让设备响应，实际应用中会有更复杂的 ACK/EOF 机制
        await asyncio.sleep(5)  # 等待5秒看是否有文件名列表过来
    except BleakError as e:
        print(f"Error sending LIST_FILES command: {e}")
    except Exception as e:
        print(f"An unexpected error occurred: {e}")


async def run():
    global control_point_char_obj, data_char_obj
    device = None

    if DEVICE_ADDRESS:
        print(f"Attempting to connect directly to {DEVICE_ADDRESS}...")
        try:
            device = await BleakScanner.find_device_by_address(
                DEVICE_ADDRESS, timeout=10.0
            )
        except BleakError as e:
            print(f"Error finding device by address: {e}")
            return
        if not device:
            print(f"Device with address {DEVICE_ADDRESS} not found.")
            return
    elif TARGET_NAME:
        print(f"Scanning for device named '{TARGET_NAME}'...")
        devices = await BleakScanner.discover(timeout=10.0)
        for d in devices:
            if d.name and TARGET_NAME.lower() in d.name.lower():
                device = d
                break
        if not device:
            print(f"Device named '{TARGET_NAME}' not found.")
            # 尝试列出所有扫描到的设备以便调试
            print("Available devices:")
            for d_info in devices:
                print(f"  {d_info.name} ({d_info.address})")
            return
    else:
        print("Please specify DEVICE_ADDRESS or TARGET_NAME.")
        return

    print(f"Found device: {device.name} ({device.address})")

    async with BleakClient(device.address) as client:
        if not client.is_connected:
            print(f"Failed to connect to {device.address}")
            return

        print(f"\nConnected to {device.name}")

        print("\nFetching services...")
        try:
            services = await client.get_services()
        except Exception as e:
            print(f"Could not get services: {e}")
            return

        file_transfer_service = None
        print("Available services:")
        for service in services:
            print(f"  Service UUID: {service.uuid}")
            if service.uuid.lower() == UUID_SVC_FILE_TRANSFER.lower():
                file_transfer_service = service
                print(f"    ^ Found File Transfer Service!")
            for char in service.characteristics:
                print(
                    f"    Characteristic UUID: {char.uuid}, Properties: {char.properties}"
                )
                if char.uuid.lower() == UUID_CHR_CONTROL_POINT.lower():
                    control_point_char_obj = char
                    print(f"        ^ Found Control Point Characteristic!")
                elif char.uuid.lower() == UUID_CHR_DATA_TRANSFER.lower():
                    data_char_obj = char
                    print(f"        ^ Found Data Transfer Characteristic!")

        if not file_transfer_service:
            print(
                f"File Transfer Service with UUID {UUID_SVC_FILE_TRANSFER} not found on the device."
            )
            return
        if not control_point_char_obj:
            print(
                f"Control Point Characteristic with UUID {UUID_CHR_CONTROL_POINT} not found."
            )
            # return # 即使控制点找不到，也可能想测试数据特性
        if not data_char_obj:
            print(
                f"Data Transfer Characteristic with UUID {UUID_CHR_DATA_TRANSFER} not found."
            )
            return  # 数据特性很重要

        print("\nService and characteristics seem to be found.")

        # 尝试订阅 Data Characteristic 的通知
        if "notify" in data_char_obj.properties:
            print(
                f"\nStarting notifications for Data Characteristic ({data_char_obj.uuid})..."
            )
            try:
                await client.start_notify(data_char_obj.uuid, notification_handler)
                print("Notifications started.")
            except Exception as e:
                print(f"Could not start notifications: {e}")
                # return # 如果通知失败，可能某些命令也无法观察结果

        # --- 测试命令 ---
        # 1. 测试 LIST_FILES
        await list_files(client)

        # 你可以在这里添加逻辑来测试其他命令，比如 START_TRANSFER, GET_CHUNK 等
        # 例如:
        # print("\nSending START_TRANSFER command for 'test.txt'...")
        # filename_bytes = "test.txt".encode('utf-8')
        # command_payload = b'\x02' + filename_bytes + b'\x00' # 0x02, filename, null terminator
        # await client.write_gatt_char(control_point_char_obj.uuid, command_payload, response=False)
        # await asyncio.sleep(1) # Give device time to open file and send SIZE:
        #
        # print("\nSending GET_CHUNK command...")
        # await client.write_gatt_char(control_point_char_obj.uuid, b'\x03', response=False) # GET_CHUNK cmd 0x03
        # await asyncio.sleep(5) # Wait for chunks

        print(
            "\nTest finished. Keeping connection alive for 10 more seconds to receive pending notifications..."
        )
        await asyncio.sleep(10)  # 保持连接以便接收后续的异步通知

        if client.is_connected and "notify" in data_char_obj.properties:
            try:
                print("Stopping notifications...")
                await client.stop_notify(data_char_obj.uuid)
            except Exception as e:
                print(f"Error stopping notifications: {e}")

        print("Disconnecting...")
    print("Disconnected.")


if __name__ == "__main__":
    if sys.platform == "win32" and sys.version_info >= (3, 8):
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

    loop = asyncio.get_event_loop()
    try:
        loop.run_until_complete(run())
    except KeyboardInterrupt:
        print("Process interrupted by user.")
    except BleakError as e:
        print(f"A Bleak error occurred: {e}")
    finally:
        print("Exiting.")
