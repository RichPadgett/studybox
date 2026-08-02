export class MockGpio {
  read(_pin: number): boolean {
    return false;
  }

  write(_pin: number, _value: boolean): void {}
}
