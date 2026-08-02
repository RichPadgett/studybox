export class RaspberryPiGpio {
  read(_pin: number): boolean {
    throw new Error("Raspberry Pi GPIO implementation is not available yet.");
  }

  write(_pin: number, _value: boolean): void {
    throw new Error("Raspberry Pi GPIO implementation is not available yet.");
  }
}
