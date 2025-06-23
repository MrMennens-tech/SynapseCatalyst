import supervisor
import time
import math
import board
import digitalio
import neopixel
import busio
import usb_hid
import usb_cdc
import json
import settings

print("\n=== CODE START ===")
print("Board:", board.board_id)

def debug_print(message):
    """Print to both console and USB serial if available"""
    # Zorg ervoor dat message een string is
    if not isinstance(message, str):
        message = str(message)

    print(message)
    try:
        if usb_cdc.data and usb_cdc.data.connected:
            usb_cdc.data.write(f"{message}\n".encode())
    except Exception as e:
        print(f"Error in debug_print: {e}")

debug_print("Debug print test...")

try:
    from DFPlayer import DFPlayer
    DFPLAYER_AVAILABLE = True
except ImportError:
    DFPLAYER_AVAILABLE = False
    debug_print("DFPlayer bibliotheek niet gevonden. DFPlayer functionaliteit is uitgeschakeld.")

# --- XAC Gamepad Report Descriptor ---
XAC_GAMEPAD_REPORT_DESCRIPTOR = bytes((
    0x05, 0x01, 0x09, 0x05, 0xA1, 0x01, 0x85, 0x05, 0x05, 0x01, 0x09, 0x30, 0x09, 0x31,
    0x15, 0x00, 0x26, 0xFF, 0x00, 0x75, 0x08, 0x95, 0x02, 0x81, 0x02, 0x05, 0x09, 0x19,
    0x01, 0x29, 0x08, 0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95, 0x08, 0x81, 0x02, 0xC0
))

# --- Configure Status LED ---
NUM_STATUS_PIXELS = 1
status_pixels = neopixel.NeoPixel(board.GP16, NUM_STATUS_PIXELS, brightness=0.1, auto_write=True)

# --- LED Ring Configuration ---
NUM_RING_LEDS = 12
LED_RING_PIN = board.GP14
led_ring = neopixel.NeoPixel(LED_RING_PIN, NUM_RING_LEDS, brightness=0.05, auto_write=False)
RAINBOW_COLORS = [
    (255, 0, 0), (255, 127, 0), (255, 255, 0), (0, 255, 0),
    (0, 0, 255), (75, 0, 130), (148, 0, 211)
]

def set_status_color(color):
    """Set the status LED color"""
    if settings.settings["dfplayer_enabled"]:
        # Als DFPlayer is ingeschakeld, gebruik oranje voor neutrale status
        if color == (0, 0, 255):  # Als het de neutrale blauwe kleur is
            color = (255, 128, 0)  # Verander naar oranje
    status_pixels.fill(color)
    status_pixels.show()

debug_print("Current settings at startup:")
debug_print(json.dumps(settings.settings))

def map_range(value, in_min, in_max, out_min, out_max):
    deadzone = settings.settings["deadzone"]
    sensitivity = settings.settings["sensitivity"]
    if abs(value) < deadzone:
        return 128
    value_abs = abs(value)
    try:
        scaled_power = math.pow(value_abs, 1.0 / sensitivity if sensitivity != 0 else 1.0)
    except (ValueError, ZeroDivisionError):
         scaled_power = value_abs
    scaled_power = min(1.0, scaled_power)
    scaled = int(scaled_power * 127)
    result = 128
    if value > 0:
        direction = settings.settings["blow_direction"]
        if direction in ["up", "left"]:
            result = 128 + scaled
        else:
            result = 128 - scaled
    elif value < 0:
        direction = settings.settings["inhale_direction"]
        if direction in ["up", "left"]:
            result = 128 + scaled
        else:
            result = 128 - scaled
    return max(0, min(255, result))

# --- GPIO Triggers ---
blow_gpio = digitalio.DigitalInOut(board.GP8)
blow_gpio.direction = digitalio.Direction.OUTPUT
blow_gpio.value = False
inhale_gpio = digitalio.DigitalInOut(board.GP19)
inhale_gpio.direction = digitalio.Direction.OUTPUT
inhale_gpio.value = False

# --- DFPlayer Mini Setup ---
dfplayer = None
if DFPLAYER_AVAILABLE:
    try:
        debug_print("Proberen DFPlayer te initialiseren...")
        dfplayer_uart = busio.UART(board.GP4, board.GP5, baudrate=9600)
        debug_print("UART voor DFPlayer geconfigureerd")
        time.sleep(1)  # Wacht tot de DFPlayer is opgestart

        # Maak een aangepaste DFPlayer klasse die de status check overslaat
        class CustomDFPlayer(DFPlayer):
            def __init__(self, uart, media=None, volume=50, eq=None, latency=0.100):
                self._uart = uart
                self._latency = latency
                self._media = media if media else DFPlayer.MEDIA_SD
                # Sla status check over
                self.set_volume(volume)
                self.set_eq(eq if eq else DFPlayer.EQ_NORMAL)

        debug_print("Proberen aangepaste DFPlayer object aan te maken...")
        dfplayer = CustomDFPlayer(dfplayer_uart, media=DFPlayer.MEDIA_SD, volume=settings.settings["min_volume"])
        debug_print("DFPlayer object aangemaakt")

        # Verwijder testcommando's en start direct met map 01, nummer 1
        if settings.settings["dfplayer_enabled"]:
            debug_print("DFPlayer is ingeschakeld, starten met afspelen...")
            debug_print("Verzenden play commando voor map 01, nummer 1...")
            dfplayer.play(folder=1, track=1)
            debug_print("Play commando verzonden")

    except Exception as e:
        debug_print(f"Fout bij initialiseren DFPlayer: {e}")
        debug_print(f"Fout type: {type(e)}")
        DFPLAYER_AVAILABLE = False

# --- Measurement Variables ---
is_measuring = False
measurement_data = {
    "max_exhale": -float('inf'),
    "min_inhale": float('inf'),
    "current_exhale_start": None,
    "current_inhale_start": None,
    "longest_exhale": 0,
    "longest_inhale": 0
}

# Buffer voor lange commando's
command_buffer = ""

def update_measurements(breath_value):
    global measurement_data
    current_time = time.monotonic()
    debug_print(f"Updating measurements with breath_value: {breath_value}")

    if breath_value > 0:
        old_max = measurement_data["max_exhale"]
        measurement_data["max_exhale"] = max(measurement_data["max_exhale"], breath_value)
        if measurement_data["max_exhale"] != old_max:
            debug_print(f"New max exhale: {measurement_data['max_exhale']}")

        if measurement_data["current_exhale_start"] is None:
            measurement_data["current_exhale_start"] = current_time
            debug_print("Started tracking exhale duration")
        if measurement_data["current_inhale_start"] is not None:
            inhale_duration = current_time - measurement_data["current_inhale_start"]
            old_longest = measurement_data["longest_inhale"]
            measurement_data["longest_inhale"] = max(measurement_data["longest_inhale"], inhale_duration)
            if measurement_data["longest_inhale"] != old_longest:
                debug_print(f"New longest inhale: {measurement_data['longest_inhale']}")
            measurement_data["current_inhale_start"] = None

    elif breath_value < 0:
        old_min = measurement_data["min_inhale"]
        measurement_data["min_inhale"] = min(measurement_data["min_inhale"], breath_value)
        if measurement_data["min_inhale"] != old_min:
            debug_print(f"New min inhale: {measurement_data['min_inhale']}")

        if measurement_data["current_inhale_start"] is None:
            measurement_data["current_inhale_start"] = current_time
            debug_print("Started tracking inhale duration")
        if measurement_data["current_exhale_start"] is not None:
            exhale_duration = current_time - measurement_data["current_exhale_start"]
            old_longest = measurement_data["longest_exhale"]
            measurement_data["longest_exhale"] = max(measurement_data["longest_exhale"], exhale_duration)
            if measurement_data["longest_exhale"] != old_longest:
                debug_print(f"New longest exhale: {measurement_data['longest_exhale']}")
            measurement_data["current_exhale_start"] = None

def handle_serial_command(command):
    global is_measuring, command_buffer
    try:
        # Zorg ervoor dat command een string is
        if isinstance(command, bytes):
            command = command.decode().strip()
        elif not isinstance(command, str):
            command = str(command).strip()
        else:
            command = command.strip()

        debug_print(f"Processing command: '{command[:50]}{'...' if len(command) > 50 else ''}'")

        # Als we een command buffer hebben, voeg dit toe
        if command_buffer:
            command_buffer += command
            debug_print(f"Added to buffer, total length: {len(command_buffer)}")

            # Check of JSON nu compleet is
            if command_buffer.strip().endswith('}'):
                complete_command = command_buffer
                command_buffer = ""  # Reset buffer
                debug_print("JSON complete, processing full command")
                # Recursief aanroepen met complete command
                handle_serial_command(complete_command)
                return
            else:
                debug_print("JSON still incomplete, waiting for more...")
                return

        # Check voor nieuwe lange commando's
        if command.startswith("SET:settings::") and not command.strip().endswith('}'):
            command_buffer = command
            debug_print("Started new JSON buffer")
            return

        # Normale commando verwerking
        debug_print(f"Processing complete command: {command[:100]}...")

        # Parse het commando
        if "::" in command:
            parts = command.split("::", 1)
            cmd_parts = parts[0].split(":")
        else:
            parts = [command]
            cmd_parts = command.split(":")

        if len(cmd_parts) < 2 and not command.startswith("SAVE"):
            debug_print(f"Invalid command format: {command}")
            return

        cmd_type = cmd_parts[0] if cmd_parts else ""
        cmd_param = cmd_parts[1] if len(cmd_parts) > 1 else ""

        debug_print(f"Command type: {cmd_type}, param: {cmd_param}")

        if cmd_type == "GET":
            if cmd_param == "settings":
                response = json.dumps(settings.settings)
                usb_cdc.data.write(f"SETTINGS::{response}\n".encode())
                debug_print("Sent current settings")

            elif cmd_param == "measurements":
                data_to_send = measurement_data.copy()
                if data_to_send["max_exhale"] == -float('inf'):
                    data_to_send["max_exhale"] = None
                if data_to_send["min_inhale"] == float('inf'):
                    data_to_send["min_inhale"] = None

                response = json.dumps(data_to_send)
                usb_cdc.data.write(f"MEASUREMENTS::{response}\n".encode())
                debug_print("Sent measurement data")

        elif cmd_type == "SET":
            if cmd_param == "settings" and len(parts) > 1:
                try:
                    json_data = parts[1]
                    debug_print(f"Parsing JSON data (length: {len(json_data)})")
                    new_settings = json.loads(json_data)
                    debug_print("JSON parsed successfully")

                    # Update settings
                    for key, value in new_settings.items():
                        settings.settings[key] = value

                    debug_print("Settings updated successfully")
                    usb_cdc.data.write(b"OK\n")

                except Exception as e:
                    error_msg = f"JSON error: {str(e)}"
                    debug_print(error_msg)
                    usb_cdc.data.write(f"ERROR:{error_msg}\n".encode())

            elif cmd_param == "measure" and len(cmd_parts) > 2:
                measure_value = cmd_parts[2]
                old_measuring = is_measuring
                is_measuring = measure_value.lower() == "true"
                debug_print(f"Measurement changed from {old_measuring} to {is_measuring}")

                if is_measuring and not old_measuring:
                    # Reset measurement data
                    measurement_data.update({
                        "max_exhale": -float('inf'),
                        "min_inhale": float('inf'),
                        "current_exhale_start": None,
                        "current_inhale_start": None,
                        "longest_exhale": 0,
                        "longest_inhale": 0
                    })
                    debug_print("Measurement data reset")

                usb_cdc.data.write(b"OK\n")

        elif cmd_type == "SAVE" or command == "SAVE":
            debug_print("Saving settings...")
            if settings.save_settings():
                usb_cdc.data.write(b"OK\n")
                debug_print("Settings saved successfully")
            else:
                usb_cdc.data.write(b"ERROR:Failed to save settings\n")
                debug_print("Failed to save settings")

        elif cmd_type == "EXPORT" or command == "EXPORT":
            debug_print("Exporting settings...")
            try:
                json_export = json.dumps(settings.settings, indent=2)
                debug_print("=== SETTINGS EXPORT ===")
                debug_print(json_export)
                debug_print("=== END EXPORT ===")
                usb_cdc.data.write(f"EXPORT::{json_export}\n".encode())
                debug_print("Settings exported successfully")
            except Exception as e:
                error_msg = f"Export error: {str(e)}"
                debug_print(error_msg)
                usb_cdc.data.write(f"ERROR:{error_msg}\n".encode())

        elif cmd_type == "IMPORT" and len(parts) > 1:
            debug_print("Importing settings...")
            try:
                json_data = parts[1]
                debug_print(f"Importing JSON data (length: {len(json_data)})")
                imported_settings = json.loads(json_data)
                debug_print("JSON parsed successfully")

                # Update settings
                for key, value in imported_settings.items():
                    settings.settings[key] = value

                debug_print("Settings imported successfully")
                usb_cdc.data.write(b"OK\n")

            except Exception as e:
                error_msg = f"Import error: {str(e)}"
                debug_print(error_msg)
                usb_cdc.data.write(f"ERROR:{error_msg}\n".encode())

    except Exception as e:
        error_msg = f"Command error: {str(e)}"
        debug_print(error_msg)
        try:
            usb_cdc.data.write(f"ERROR:{error_msg}\n".encode())
        except Exception:
            pass

debug_print("GroovTube XAC Gamepad starting...")

# --- Global Gamepad Variables ---
gamepad = None
hid_enabled = False

if usb_hid.devices:
    print(f"[CODE] Found USB HID devices: {usb_hid.devices}")
    for device in usb_hid.devices:
        if device.usage_page == 0x01 and device.usage == 0x05:
            try:
                from hid_xac_gamepad import Gamepad
                gamepad = Gamepad(usb_hid.devices)
                gamepad.move_joysticks(x=128, y=128)
                hid_enabled = True
                print("[CODE] Gamepad class initialized and joysticks centered.")
            except Exception as e:
                print(f"[CODE] Error initializing Gamepad class: {e}")
            break
else:
    print("[CODE] No USB HID devices found.")

if not hid_enabled:
    print("[CODE] Continuing without HID Gamepad.")

# --- UART Initialization ---
uart = None
try:
    uart = busio.UART(board.GP0, board.GP1, baudrate=115200)
    debug_print("UART initialized")
    set_status_color((0, 0, 255))
except Exception as e:
    debug_print(f"Error initializing UART: {e}")
    set_status_color((64, 0, 64))

# --- LED Ring State Variables
current_rainbow_index = 0
current_ring_color = RAINBOW_COLORS[current_rainbow_index]
last_breath_state = "neutral"
pep_success_start_time = None
pep_target_reached = False

def set_led_color_from_settings():
    """Stel LED kleur in op basis van instellingen"""
    if not settings.settings["led_enabled"]:
        led_ring.fill((0, 0, 0))
        led_ring.show()
        return

    color_mode = settings.settings["led_color_mode"]
    if color_mode == "single":
        color = settings.settings["led_single_color"]
        led_ring.fill(tuple(color))
    elif color_mode == "rainbow":
        led_ring.fill(current_ring_color)

    led_ring.brightness = settings.settings["led_start_brightness"]
    led_ring.show()

def handle_pep_mode(breath_value):
    """Handle PEP (Positive Expiratory Pressure) mode"""
    global pep_success_start_time, pep_target_reached

    if not settings.settings["pep_mode_enabled"]:
        return False

    current_time = time.monotonic()
    target_value = settings.settings["pep_target_value"]

    if breath_value >= target_value:
        if not pep_target_reached:
            pep_target_reached = True
            pep_success_start_time = current_time
            debug_print(f"PEP target reached! {breath_value} >= {target_value}")

        # Groene LED tijdens succes met variabele helderheid
        # Helderheid neemt toe naarmate je meer uitademt boven de drempel
        extra_breath = breath_value - target_value
        max_extra = 1.0 - target_value  # Maximale extra ademhaling mogelijk
        if max_extra > 0:
            brightness_factor = min(1.0, extra_breath / max_extra)
        else:
            brightness_factor = 1.0

        # Bereken helderheid tussen start en max brightness
        pep_brightness = settings.settings["pep_start_brightness"] + brightness_factor * (settings.settings["pep_max_brightness"] - settings.settings["pep_start_brightness"])

        success_color = settings.settings["pep_success_color"]
        led_ring.fill(tuple(success_color))
        led_ring.brightness = pep_brightness
        led_ring.show()

        # Check of de tijd om is
        if current_time - pep_success_start_time >= settings.settings["pep_hold_time"]:
            debug_print("PEP hold time completed!")
            pep_target_reached = False
            pep_success_start_time = None

            # Knipperen met instelbare waarden
            blink_times = settings.settings["pep_blink_times"]
            blink_speed = settings.settings["pep_blink_speed"]

            for i in range(blink_times):
                # Uit
                led_ring.fill((0, 0, 0))
                led_ring.show()
                time.sleep(blink_speed)
                # Aan (met max helderheid)
                led_ring.fill(tuple(success_color))
                led_ring.brightness = settings.settings["pep_max_brightness"]
                led_ring.show()
                time.sleep(blink_speed)

            debug_print(f"PEP success blink completed ({blink_times} times)")

        return True
    else:
        if pep_target_reached:
            pep_target_reached = False
            pep_success_start_time = None
            debug_print("PEP target lost")

        # Rode LED voor start/wachten met variabele helderheid
        # Helderheid neemt toe naarmate je dichter bij de doelwaarde komt
        if target_value > 0:
            progress = min(1.0, breath_value / target_value) if breath_value > 0 else 0
        else:
            progress = 0

        # Bereken helderheid tussen start en max brightness
        pep_brightness = settings.settings["pep_start_brightness"] + progress * (settings.settings["pep_max_brightness"] - settings.settings["pep_start_brightness"])

        start_color = settings.settings["pep_start_color"]
        led_ring.fill(tuple(start_color))
        led_ring.brightness = pep_brightness
        led_ring.show()
        return True

def handle_gamepad_buttons(breath_value):
    """Handle gamepad button presses based on breath values"""
    if not gamepad or settings.settings["control_mode"] != "buttons":
        return

    # Blazen knop
    blow_button = settings.settings["blow_button"]
    if blow_button != "none" and breath_value > settings.settings["blow_threshold"]:
        button_num = int(blow_button)
        debug_print(f"Pressing blow button {button_num}")
        gamepad.press_buttons(button_num)

    # Inademen knop
    inhale_button = settings.settings["inhale_button"]
    if inhale_button != "none" and breath_value < -settings.settings["inhale_threshold"]:
        button_num = int(inhale_button)
        debug_print(f"Pressing inhale button {button_num}")
        gamepad.press_buttons(button_num)

    # Release alle knoppen als we in de deadzone zijn
    if abs(breath_value) < settings.settings["deadzone"]:
        gamepad.release_buttons()

# Initialize LED ring with settings
set_led_color_from_settings()

# --- Main Loop ---
last_uart_success = time.monotonic()
breath_value = 0.0

while True:
    try:
        # Check USB Serial for commands
        if usb_cdc.data and usb_cdc.data.in_waiting:
            # Lees alle beschikbare bytes
            available_bytes = usb_cdc.data.read(usb_cdc.data.in_waiting)
            if available_bytes:
                debug_print(f"Raw bytes received: {list(available_bytes)}")
                try:
                    command = available_bytes.decode('utf-8')
                    debug_print(f"Decoded command: '{command.strip()}'")
                    if command.strip():  # Alleen verwerken als er daadwerkelijk een commando is
                        handle_serial_command(command)
                except UnicodeDecodeError as e:
                    debug_print(f"Unicode decode error: {e}")
                except Exception as e:
                    debug_print(f"Error processing command: {e}")

        if uart is not None and uart.in_waiting:
            data_line = uart.readline()
            if data_line:
                try:
                    breath_value = float(data_line.decode().strip())
                    last_uart_success = time.monotonic()

                    if usb_cdc.data and usb_cdc.data.connected:
                        usb_cdc.data.write(f"BREATH_DATA:{breath_value}\n".encode())

                    if is_measuring:
                        update_measurements(breath_value)

                    # GPIO triggers
                    blow_gpio.value = breath_value > settings.settings["blow_gpio_threshold"]
                    inhale_gpio.value = breath_value < settings.settings["inhale_gpio_threshold"]

                    # DFPlayer functionaliteit (verbeterd)
                    if settings.settings["dfplayer_enabled"] and DFPLAYER_AVAILABLE and dfplayer is not None:
                        try:
                            if breath_value > 0 and breath_value > settings.settings["deadzone"]:  # Uitademen - volume omhoog
                                current_volume = min(
                                    settings.settings["max_volume"],
                                    settings.settings["current_volume"] + 5
                                )
                                if current_volume != settings.settings["current_volume"]:
                                    settings.settings["current_volume"] = current_volume
                                    dfplayer.set_volume(current_volume)
                                    debug_print(f"Volume verhoogd naar: {current_volume}")
                            else:
                                # Niet blazen: direct terug naar min_volume
                                if settings.settings["current_volume"] != settings.settings["min_volume"]:
                                    settings.settings["current_volume"] = settings.settings["min_volume"]
                                    dfplayer.set_volume(settings.settings["min_volume"])
                                    debug_print(f"Volume terug naar min: {settings.settings['min_volume']}")

                            if breath_value < settings.settings["track_change_threshold"]:  # Inademen drempel voor volgend nummer
                                current_track = settings.settings["current_track"]
                                # Bepaal het aantal tracks in map 01 (stel in als constante of haal dynamisch op)
                                NUM_TRACKS = 5  # Pas dit aan naar het juiste aantal tracks
                                new_track = (current_track % NUM_TRACKS) + 1  # 1-NUM_TRACKS
                                if new_track != current_track:
                                    settings.settings["current_track"] = new_track
                                    dfplayer.play(folder=1, track=new_track)  # Speel af uit map 01
                                    debug_print(f"Volgend nummer: map 01, nummer {new_track:03d}.mp3 (volume: {settings.settings['current_volume']})")
                        except Exception as e:
                            debug_print(f"Fout bij DFPlayer operatie: {e}")
                            settings.settings["dfplayer_enabled"] = False

                    # Check PEP modus eerst (heeft prioriteit over normale LED)
                    pep_handled = handle_pep_mode(breath_value)

                    if settings.settings["control_mode"] == "joystick":
                        x, y = 128, 128
                        deadzone = settings.settings["deadzone"]
                        is_blowing = breath_value > deadzone
                        is_inhaling = breath_value < -deadzone

                        current_direction = None
                        if is_blowing: current_direction = settings.settings["blow_direction"]
                        elif is_inhaling: current_direction = settings.settings["inhale_direction"]

                        if current_direction:
                            mapped_value = map_range(breath_value, -1.0, 1.0, 0, 255)
                            if current_direction in ["up", "down"]: y = mapped_value
                            elif current_direction in ["left", "right"]: x = mapped_value

                        if gamepad:
                            gamepad.move_joysticks(x=y, y=x)  # x en y omgewisseld

                        if is_blowing: set_status_color((0, 255, 0))
                        elif is_inhaling: set_status_color((255, 0, 0))
                        else: set_status_color((0, 0, 255))

                        # LED Ring Logic (alleen als PEP modus niet actief is)
                        if not pep_handled and settings.settings["led_enabled"]:
                            deadzone_for_led = settings.settings.get("deadzone", 0.05)
                            new_breath_state = "neutral"

                            if breath_value > deadzone_for_led:
                                new_breath_state = "exhaling"
                                norm_exhale = min(1.0, (abs(breath_value) - deadzone_for_led) / (1.0 - deadzone_for_led))
                                target_brightness = settings.settings["led_start_brightness"] + norm_exhale * (settings.settings["led_max_brightness"] - settings.settings["led_start_brightness"])
                                led_ring.brightness = target_brightness

                                if settings.settings["led_color_mode"] == "rainbow":
                                    led_ring.fill(current_ring_color)
                                elif settings.settings["led_color_mode"] == "single":
                                    led_ring.fill(tuple(settings.settings["led_single_color"]))
                                elif settings.settings["led_color_mode"] == "breathing":
                                    # Breathing effect: kleur verandert met ademhaling
                                    breathing_color = [int(c * norm_exhale) for c in settings.settings["led_single_color"]]
                                    led_ring.fill(tuple(breathing_color))

                            elif breath_value < -deadzone_for_led:
                                new_breath_state = "inhaling"
                                if last_breath_state != "inhaling" and settings.settings["led_color_mode"] == "rainbow":
                                    current_rainbow_index = (current_rainbow_index + 1) % len(RAINBOW_COLORS)
                                    current_ring_color = RAINBOW_COLORS[current_rainbow_index]
                                    debug_print(f"New inhale detected. Ring color index: {current_rainbow_index}")

                                led_ring.brightness = settings.settings["led_start_brightness"]

                                if settings.settings["led_color_mode"] == "rainbow":
                                    led_ring.fill(current_ring_color)
                                elif settings.settings["led_color_mode"] == "single":
                                    led_ring.fill(tuple(settings.settings["led_single_color"]))
                                elif settings.settings["led_color_mode"] == "breathing":
                                    led_ring.fill(tuple(settings.settings["led_single_color"]))

                            else:
                                new_breath_state = "neutral"
                                led_ring.brightness = settings.settings["led_start_brightness"]
                                set_led_color_from_settings()

                            if new_breath_state != last_breath_state or new_breath_state != "neutral":
                                 led_ring.show()
                            last_breath_state = new_breath_state

                    elif settings.settings["control_mode"] == "buttons":
                        # Gamepad knoppen modus
                        handle_gamepad_buttons(breath_value)

                        # Release alle knoppen als we in de deadzone zijn
                        if abs(breath_value) < settings.settings["deadzone"]:
                            if gamepad:
                                gamepad.release_all_buttons()

                        # Status LED voor knoppen modus
                        if abs(breath_value) > settings.settings["deadzone"]:
                            set_status_color((255, 255, 0))  # Geel voor actieve knop
                        else:
                            set_status_color((0, 0, 255))   # Blauw voor neutraal

                except (ValueError, UnicodeError) as e:
                    debug_print(f"Error parsing UART data: {e}")
                except Exception as e:
                    debug_print(f"General error in UART processing: {e}")

        if time.monotonic() - last_uart_success > 2.0:
            set_status_color((64, 0, 64)) # Purple for timeout

    except Exception as e:
        debug_print(f"Main loop error: {e}")
        set_status_color((255, 64, 0)) # Orange for error
        time.sleep(1)

    # Verwijder de sleep om communicatie te verbeteren
    # time.sleep(0.01)
