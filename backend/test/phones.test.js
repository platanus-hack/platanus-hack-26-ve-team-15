import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toInternational } from '../src/phones.js';

// Las mismas filas viven en la prueba de Android (PhoneNumbersTest): el servidor y la app deben coincidir.
const CASES = [
  ['04148539491', '584148539491'],
  ['0414-853-9491', '584148539491'],
  ['(0414) 853.94.91', '584148539491'],
  ['4148539491', '584148539491'],
  ['+584148539491', '584148539491'],
  ['+58 414 853 9491', '584148539491'],
  ['584148539491', '584148539491'],
  ['+580414 8539491', '584148539491'],
  ['5804148539491', '584148539491'],
  ['0058 414 853 9491', '584148539491'],
  ['00580414 853 9491', '584148539491'],
  ['0212-555-1234', '582125551234'],
  ['+56 9 2040 3095', '56920403095'],
  ['56920403095', '56920403095'],
  ['+1 205-855-3931', '12058553931'],
  ['+58 000-0000001', '580000000001'],
  ['', ''],
  ['sin número', ''],
];

test('teléfonos al formato internacional de WhatsApp, con los formatos de Venezuela', () => {
  for (const [raw, expected] of CASES) assert.equal(toInternational(raw), expected, `«${raw}»`);
});
