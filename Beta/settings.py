import json
import os
import supervisor
import storage # Importeer de storage module

# Default settings (fallback values)
DEFAULT_SETTINGS = {
    "control_mode": "joystick",

    # Joystick instellingen
    "deadzone": 0.02,
    "sensitivity": 2.0,
    "blow_direction": "right",
    "inhale_direction": "left",

    # Gamepad knop instellingen
    "blow_button": "none",
    "inhale_button": "none",
    "blow_threshold": 0.5,        # Drempelwaarde voor blazen knop
    "inhale_threshold": 0.5,      # Drempelwaarde voor inademen knop

    # GPIO trigger instellingen
    "blow_gpio_threshold": 0.7,
    "inhale_gpio_threshold": -0.7,
    "blow_gpio_pin": 8,
    "inhale_gpio_pin": 9,

    # LED Ring instellingen
    "led_enabled": True,
    "led_start_brightness": 0.05,  # 5% start helderheid
    "led_max_brightness": 1.0,     # 100% max helderheid
    "led_color_mode": "rainbow",   # "rainbow", "single", "breathing"
    "led_single_color": [255, 0, 0], # Rood voor single mode

    # PEP Modus instellingen
    "pep_mode_enabled": False,
    "pep_target_value": 0.8,       # Doelwaarde voor PEP
    "pep_hold_time": 2.0,          # Tijd in seconden om groen te blijven
    "pep_start_color": [255, 0, 0], # Rood
    "pep_success_color": [0, 255, 0], # Groen
    "pep_start_brightness": 0.3,   # Start helderheid voor PEP (30%)
    "pep_max_brightness": 1.0,     # Max helderheid voor PEP (100%)
    "pep_blink_times": 3,          # Aantal keer knipperen bij succes
    "pep_blink_speed": 0.2,        # Knippersnelheid in seconden

    # DFPlayer MP3 instellingen
    "dfplayer_enabled": False,
    "current_track": 1,
    "min_volume": 5,
    "max_volume": 30,
    "current_volume": 10,
    "track_change_threshold": -0.5  # Inademen drempel voor volgende nummer
}

# Current settings dictionary
try:
    import copy
    settings = copy.deepcopy(DEFAULT_SETTINGS)
except ImportError:
    settings = DEFAULT_SETTINGS.copy()

SETTINGS_FILENAME = "/settings.json"

def load_settings():
    """Load settings from file, updating the global 'settings' dictionary."""
    global settings
    print(f"Attempting to load settings from '{SETTINGS_FILENAME}'...")
    # Check if file exists first
    try:
        os.stat(SETTINGS_FILENAME)
        file_found = True
    except OSError:
        file_found = False
        print(f"File '{SETTINGS_FILENAME}' not found.")

    if file_found:
        try:
            with open(SETTINGS_FILENAME, "r") as f:
                try:
                    loaded_settings = json.load(f)
                    print("JSON data loaded successfully.")
                    settings.update(loaded_settings)
                    print(f"Settings updated successfully from '{SETTINGS_FILENAME}'.")
                    return True
                except json.JSONDecodeError as e:
                    print(f"ERROR: Invalid JSON format in '{SETTINGS_FILENAME}': {e}")
                    print("Using default settings instead.")
                    return False
                except Exception as e:
                     print(f"ERROR: Unexpected error processing file '{SETTINGS_FILENAME}': {e}")
                     print("Using default settings instead.")
                     return False
        except OSError as e:
             print(f"ERROR: Could not open existing file '{SETTINGS_FILENAME}': {e}")
             print("Using default settings instead.")
             return False
        except Exception as e:
             print(f"ERROR: Unexpected error reading settings file: {e}")
             print("Using default settings instead.")
             return False
    else:
        # File not found, use defaults and try to create it
        print("Using default settings and attempting to create file.")
        if save_settings():
             print(f"Default settings saved to new '{SETTINGS_FILENAME}'.")
        else:
             print(f"ERROR: Failed to create '{SETTINGS_FILENAME}' with default settings (filesystem might be read-only).")
        return False

def save_settings():
    """Save current settings dictionary to file, attempting to remount filesystem."""
    global settings
    print(f"Attempting to save settings to '{SETTINGS_FILENAME}'...")
    print(f"Current settings keys: {list(settings.keys())}")
    write_success = False

    # --- Unconditionally attempt to make filesystem writable ---
    try:
        print("Attempting remount to writable...")
        storage.remount("/", readonly=False)
        print("Remount to writable successful (or already writable).")
        # Proceed to write the file
        try:
            print("Opening file for writing...")
            with open(SETTINGS_FILENAME, "w") as f:
                print("Converting settings to JSON...")
                json_string = json.dumps(settings)
                print(f"JSON string created, length: {len(json_string)}")
                f.write(json_string)
                print("JSON string written to file")
            print("Settings successfully written to file.")
            write_success = True # Mark success only if write completes
        except OSError as e:
            print(f"ERROR: Could not write to '{SETTINGS_FILENAME}': {e}")
            write_success = False
        except TypeError as e:
             # Catch the specific error we saw before, plus others
             print(f"ERROR: TypeError during json operations: {e}")
             print(f"Problematic settings: {settings}")
             write_success = False
        except Exception as e:
            print(f"ERROR: Unexpected error saving settings during write: {e}")
            write_success = False

    except Exception as e:
        # This catches errors during the remount attempt itself
        print(f"ERROR: Failed during remount to writable: {e}")
        print("Proceeding to try writing anyway, in case it was already writable...")
        try:
            with open(SETTINGS_FILENAME, "w") as f:
                json_string = json.dumps(settings)
                f.write(json_string)
            print("Settings successfully written to file (despite remount error).")
            write_success = True
        except OSError as e:
            print(f"ERROR: Could not write to '{SETTINGS_FILENAME}' after remount error: {e}")
            write_success = False
        except TypeError as e:
             # Catch the specific error we saw before, plus others
             print(f"ERROR: TypeError during json operations (after remount error): {e}")
             print(f"Problematic settings: {settings}")
             write_success = False
        except Exception as ex:
            print(f"ERROR: Unexpected error saving settings after remount error: {ex}")
            write_success = False

    # --- ALWAYS attempt to remount back to read-only in a finally block ---
    finally:
        try:
            print("Attempting remount back to read-only...")
            storage.remount("/", readonly=True)
            print("Remount back to read-only successful (attempted).")
        except Exception as e:
            print(f"ERROR: Failed to remount filesystem back to read-only: {e}")

    print(f"Save operation result: {write_success}")
    return write_success # Return whether the write operation itself succeeded

# --- Initial Load Attempt ---
load_settings()
print("Settings module initialization complete.")

