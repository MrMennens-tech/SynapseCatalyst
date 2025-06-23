import storage
import supervisor
import board
import usb_cdc
import usb_hid
import traceback # Import traceback for detailed error info
import time

# Make filesystem writable so we can create log files
# storage.remount("/", readonly=False)

def log_message(message):
    try:
        with open("/log.txt", "a") as f:
            timestamp = time.monotonic()
            f.write(f"[{timestamp:.3f}] {message}\n")
    except Exception as e:
        # If we can't write to the file, we can't do much about it
        pass

log_message("Starting boot.py...")

# Disable auto-reload during development
supervisor.runtime.autoreload = False # Ensure this is active
log_message("Auto-reload disabled.") # Added debug output

# --- XAC Gamepad Report Descriptor (moved back from code.py) ---
XAC_GAMEPAD_REPORT_DESCRIPTOR = bytes((
    0x05, 0x01,  # Usage Page (Generic Desktop Ctrls)
    0x09, 0x05,  # Usage (GamePad)
    0xA1, 0x01,  # Collection (Application)
    0x85, 0x05,  #   Report ID (5)
    0x05, 0x01,  #   Usage Page (Generic Desktop Ctrls)
    0x09, 0x30,  #   Usage (X)
    0x09, 0x31,  #   Usage (Y)
    0x15, 0x00,  #   Logical Minimum (0)
    0x26, 0xFF, 0x00,  #   Logical Maximum (255)
    0x75, 0x08,  #   Report Size (8)
    0x95, 0x02,  #   Report Count (2)
    0x81, 0x02,  #   Input (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position)
    0x05, 0x09,  #   Usage Page (Button)
    0x19, 0x01,  #   Usage Minimum (0x01)
    0x29, 0x08,  #   Usage Maximum (0x08)
    0x15, 0x00,  #   Logical Minimum (0)
    0x25, 0x01,  #   Logical Maximum (1)
    0x75, 0x01,  #   Report Size (1)
    0x95, 0x08,  #   Report Count (8)
    0x81, 0x02,  #   Input (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position)
    0xC0,        # End Collection
))
log_message("Report descriptor defined.") # Added debug output

# --- Attempt HID Initialization in boot.py ---
try:
    log_message("Attempting to enable USB HID...")
    gamepad_device = usb_hid.Device(
        report_descriptor=XAC_GAMEPAD_REPORT_DESCRIPTOR,
        usage_page=0x01,
        usage=0x05,
        report_ids=(5,),
        in_report_lengths=(3,),
        out_report_lengths=(0,),
    )
    usb_hid.enable((gamepad_device,))
    log_message("USB HID enabled successfully.")
except Exception as e: # Catch all exceptions for now
    error_msg = f"Error during USB HID initialization: {e}"
    log_message(error_msg)
    try:
        import traceback
        with open("/log.txt", "a") as f:
            f.write("Traceback:\n")
            traceback.print_exception(e, file=f)
    except:
        pass

# Enable USB CDC for console and data (after HID attempt)
try:
    usb_cdc.enable(console=True, data=True)
    log_message("USB CDC enabled.") # Added debug output
except Exception as e:
    error_msg = f"Error enabling USB CDC: {e}"
    log_message(error_msg)
    try:
        import traceback
        with open("/log.txt", "a") as f:
            f.write("Traceback:\n")
            traceback.print_exception(e, file=f)
    except:
        pass

log_message("Boot complete - CDC enabled, HID status logged above.")
