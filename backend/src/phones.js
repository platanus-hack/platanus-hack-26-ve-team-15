// Teléfonos al formato que exigen WhatsApp (Kapso), Twilio y la llamada: solo cifras, con código de país.
// Pensado para Venezuela, donde la agenda suele guardar el número local: 0414 853 9491, +58 414…, 58414…,
// +58 0414…, 0058 414… → 584148539491. Un número de otro país con '+' (o ya con su código) se deja como está.
const VENEZUELA = '58';
const NATIONAL_DIGITS = 10; // 414 853 9491, 212 555 1234

export function toInternational(raw, countryCode = VENEZUELA) {
  const text = String(raw ?? '').trim();
  const d = text.replace(/\D/g, '');
  if (d.startsWith('00')) return dropTrunkZero(d.slice(2), countryCode); // prefijo internacional: 0058 414…
  if (text.startsWith('+')) return dropTrunkZero(d, countryCode);
  return fromNational(d, countryCode) ?? dropTrunkZero(d, countryCode);
}

/** Sin '+' ni 00: «0414 853 9491» o «414 853 9491» son números del país; otra longitud, null. */
function fromNational(d, countryCode) {
  if (d.length === NATIONAL_DIGITS + 1 && d.startsWith('0')) return countryCode + d.slice(1);
  return d.length === NATIONAL_DIGITS ? countryCode + d : null;
}

/** «+58 0414…»: el 0 nacional escrito después del código de país. Solo con la longitud de un número real. */
function dropTrunkZero(d, countryCode) {
  const isTrunk = d.length === countryCode.length + NATIONAL_DIGITS + 1 && d.startsWith(`${countryCode}0`);
  return isTrunk ? countryCode + d.slice(countryCode.length + 1) : d;
}
