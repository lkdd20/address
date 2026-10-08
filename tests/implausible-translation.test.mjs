import { describe, expect, it } from 'vitest';
import { implausibleChineseTranslation, usableAddressTranslation } from '../src/domain/address-localization.mjs';

describe('implausible Chinese translations', () => {
  it.each([
    ['Торфяная улица', '它是什么？'],
    ['Kansbahal', '对不起'],
    ['улица Можайского', '乌利萨·莫卡伊斯科戈'],
    ['улица Камиля Омарова', '卡米莉亚·奥马罗娃'],
    ['Тюбук', '管'],
    ['Badger', '獾'],
    ['Harrow', '耙'],
    ['وزير بن المهاجر', '暂无说明，留下第一条！'],
    ['Bursa', '囊']
  ])('rejects %s → %s', (original, translated) => {
    expect(implausibleChineseTranslation(original, translated)).toBe(true);
    expect(usableAddressTranslation(translated, 'zh-CN', original)).toBe(false);
  });

  it.each([
    ['Советская улица', '苏维埃大街'],
    ['площадь Ленина', '列宁广场'],
    ['Бульвар Мира', '和平林荫道'],
    ['Куса', '库萨'],
    ['Rau', '劳'],
    ['Street', '街'],
    ['West', '西'],
    ['Block', '栋'],
    ['Москва', '莫斯科'],
    ['Bokku! Mart', '博库！玛特'],
    ['Tower', '塔']
  ])('accepts %s → %s', (original, translated) => {
    expect(implausibleChineseTranslation(original, translated)).toBe(false);
    expect(usableAddressTranslation(translated, 'zh-CN', original)).toBe(true);
  });
});
