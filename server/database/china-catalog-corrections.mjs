// Corrections for the upstream (dr5hn) China catalog: Chinese names cut down to their first character
// (滨州 → 滨), Jiangsu cities filed under the Taiwan province, and two Jiangsu towns given the name of a
// prefecture-level city elsewhere (Taizhou 泰州 written 台州, Zhenzhou 真州 written 郑州).
const JIANGSU_SOUTHERN_LATITUDE = 30;
const misnamedTowns = [
  { name: 'Taizhou', wrong: '台州', correct: '泰州', latitude: [32, 33], longitude: [119.5, 120.5] },
  { name: 'Zhenzhou', wrong: '郑州', correct: '真州', latitude: [32, 32.6], longitude: [118.8, 119.5] }
];
const within = (value, [minimum, maximum]) => Number(value) >= minimum && Number(value) <= maximum;

export const chinaCityRegionCode = (regionCode, latitude) =>
  regionCode === 'TW' && Number(latitude) > JIANGSU_SOUTHERN_LATITUDE ? 'JS' : regionCode;

export const chinaCityNames = ({ name, native, zh, latitude, longitude }) => {
  const town = misnamedTowns.find((entry) => entry.name === name && entry.wrong === native
    && within(latitude, entry.latitude) && within(longitude, entry.longitude));
  if (town) return { native: town.correct, zh: town.correct };
  const truncated = /\p{Script=Han}/u.test(native || '') && zh && zh !== native && native.startsWith(zh);
  return { native, zh: truncated ? native : zh };
};
