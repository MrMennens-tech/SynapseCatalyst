import sys
if sys.implementation.version[0] < 7:
    raise ImportError('{0} is not supported in CircuitPython 7.x or lower'.format(__name__))

import struct
import time

from adafruit_hid import find_device

class Gamepad:
    def __init__(self, devices):
        self._gamepad_device = find_device(devices, usage_page=0x1, usage=0x05)
        self._report = bytearray(3)
        self._last_report = bytearray(3)
        self._joy_x = 128
        self._joy_y = 128
        self._buttons_state = 0

        try:
            self.reset_all()
        except OSError:
            time.sleep(1)
            self.reset_all()

    def press_buttons(self, *buttons):
        for button in buttons:
            self._buttons_state |= 1 << self._validate_button_number(button) - 1
        self._send()

    def release_buttons(self, *buttons):
        for button in buttons:
            self._buttons_state &= ~(1 << self._validate_button_number(button) - 1)
        self._send()

    def release_all_buttons(self):
        self._buttons_state = 0
        self._send()

    def click_buttons(self, *buttons):
        self.press_buttons(*buttons)
        self.release_buttons(*buttons)

    def move_joysticks(self, x=None, y=None):
        if x is not None:
            self._joy_x = self._validate_joystick_value(x)
        if y is not None:
            self._joy_y = self._validate_joystick_value(y)
        self._send()

    def reset_all(self):
        self._buttons_state = 0
        self._joy_x = 128
        self._joy_y = 128
        self._send(always=True)

    def _send(self, always=False):
        struct.pack_into('<BBB', self._report, 0,
                         self._joy_y, self._joy_x, self._buttons_state)

        if always or self._last_report != self._report:
            self._gamepad_device.send_report(self._report)
            self._last_report[:] = self._report

    @staticmethod
    def _validate_button_number(button):
        if not 1 <= button <= 8:
            raise ValueError("Button number must in range 1 to 8")
        return button

    @staticmethod
    def _validate_joystick_value(value):
        if not 0 <= value <= 255:
            raise ValueError("Joystick value must be in range 0 to 255")
        return value 