import { describe, expect, it } from 'vitest';
import { expandEnglishStreetType, implausibleChineseTranslation, implausibleEnglishTranslation, normalizeChineseStreetType, usableAddressTranslation } from '../src/domain/address-localization.mjs';

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
    ['Bursa', '囊'],
    ['내원로', '是时候该走了。'],
    ['대덕로', '我爱你'],
    ['학동', '首页'],
    ['شارع الصلاة', '祈祷的意义'],
    ['ซอยปราโมทย์ 4', '第 4 章'],
    ['봉락노라포1길', '1年前'],
    ['Boa Viagem', '祝你旅途愉快'],
    ['Casa', '首页'],
    ['MOYLAN WAY', '我的方式'],
    ['Rua I', '我街'],
    ['MYALL CLOSE', '我的全部关闭'],
    ['Im Wiesengrund', '我是维森格伦德'],
    ['Rue du Moulin', '我的磨坊路'],
    ['227 ST', '第227章'],
    ['Okosun Close', '您的持仓将被平仓。'],
    ['Judge Close', '克洛斯法官'],
    ['Juniper Drive', '杜松驱动器'],
    ['Marine DR', '海洋灾难恢复'],
    ['2nd ST', '2nd 意法半导体']
  ])('rejects %s → %s', (original, translated) => {
    expect(implausibleChineseTranslation(original, translated, 'street')).toBe(true);
    expect(usableAddressTranslation(translated, 'zh-CN', original, 'street')).toBe(false);
  });

  it('checks English street types on streets only', () => {
    expect(implausibleChineseTranslation('Vivier au court', '维维耶奥库尔', 'locality')).toBe(false);
    expect(usableAddressTranslation('维维耶奥库尔', 'zh-CN', 'Vivier au court', 'locality')).toBe(true);
    expect(implausibleChineseTranslation('Vivier au court', '维维耶奥库尔')).toBe(false);
    expect(implausibleChineseTranslation('Kensington Court', '肯辛顿', 'street')).toBe(true);
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
    ['Tower', '塔'],
    ['我孫子', '我孙子'],
    ['마라로', '马罗路'],
    ['Nia Road', '妮娅路'],
    ['Big C Mini', '大C迷你'],
    ['우리저축은행', '我们储蓄银行'],
    ['Darkside Lab.', '暗面实验室。'],
    ['Saint Gregory', '圣额我略'],
    ['You & I Apartments', '你和我公寓'],
    ['Rue des myosotis', '勿忘我街'],
    ['St. Dominic Catholic Church', '圣多明我天主教堂'],
    ['Mon Brico', '我的家装'],
    ['Mis Niñas', '我的女孩们'],
    ['rumah ku', '我的房子'],
    ['myNEWS.com', '我的新闻网'],
    ['I Can Learning Centre', '我能学习中心'],
    ['Stratton Drive', '斯特拉顿大道'],
    ['Kensington Court', '肯辛顿阁'],
    ['West 23rd Street', '西 23rd 街'],
    ['HWY 128', 'HWY 128号公路'],
    ['St Kilda Road', '圣基尔达路'],
    ['Le Bar et Vous', '酒吧与您'],
    ["Un jour une fleur m'a dit", '有一天一朵花对我说'],
    ['Église protestante Notre Seigneur Jésus', '我主耶稣新教教堂']
  ])('accepts %s → %s', (original, translated) => {
    expect(implausibleChineseTranslation(original, translated)).toBe(false);
    expect(usableAddressTranslation(translated, 'zh-CN', original)).toBe(true);
  });
});

describe('implausible English translations', () => {
  it.each([
    ['Заржавенская улица', 'What is it?'],
    ['Новый', 'What is it?'],
    ['마라로', "I'm in love."],
    ['대덕로', 'I love you'],
    ['학동', 'Home'],
    ['월포길', 'trumpet'],
    ['마동', 'Sorry'],
    ['봉락노라포1길', '1 year ago'],
    ['삼성래미안', 'Sorry to bother you'],
    ['琴似三条五丁目', 'What is the meaning of the story?'],
    ['北郷七条九丁目', "It's a beautiful scenery."],
    ['شارع الصلاة', 'The meaning of prayer'],
    ['หมู่บ้านสุขใจ', '1'],
    ['Калининградский проспект', 'Kaliningrad'],
    ['홍성군 홍성읍', 'Home page'],
    ['จะนะ', 'I will.']
  ])('rejects %s → %s', (original, translated) => {
    expect(implausibleEnglishTranslation(original, translated, 'street')).toBe(true);
    expect(usableAddressTranslation(translated, 'en', original, 'street')).toBe(false);
  });

  it.each([
    ['마라로', 'Mara-ro'],
    ['종로', 'Jongno'],
    ['마라로101번길', 'Mara-ro 101beon-gil'],
    ['학동', 'Hak-dong'],
    ['역삼1동', 'Yeoksam 1(il)-dong'],
    ['신포동1가', 'Sinpo-dong 1-ga'],
    ['송리', 'Song-ri'],
    ['서울특별시', 'Seoul'],
    ['남산동', 'Namsan-dong'],
    ['Заржавенская улица', 'Zarzhavenskaya Street'],
    ['Калининградский проспект', 'Kaliningradsky Prospekt'],
    ['площадь Ленина', 'Lenin Square'],
    ['Зелёный тупик', 'Green Cul-de-sac'],
    ['Магистральный проезд', 'Magistralny Proyezd'],
    ['Новый', 'Novy'],
    ['琴似三条五丁目', 'Kotoni 3-jo 5-chome'],
    ['阿児町', 'Ago-cho'],
    ['طريق الملك فهد', 'King Fahd Road'],
    ['Main Street', 'Main St.'],
    ['Rue de la Paix', 'Peace Street?'],
    ['حي محاسن الأول', 'Mahasen I Neighborhood'],
    ['Дальневосточная МИС', 'Far Eastern M.I.S.'],
    ['อิสาณ', 'I San']
  ])('accepts %s → %s', (original, translated) => {
    expect(implausibleEnglishTranslation(original, translated, 'street')).toBe(false);
  });

  it('checks the Korean place type only for streets and neighbourhoods', () => {
    expect(implausibleEnglishTranslation('원앤온리', 'One and Only', 'buildingName')).toBe(false);
    expect(implausibleEnglishTranslation('원앤온리', 'One and Only', 'street')).toBe(true);
    expect(implausibleEnglishTranslation('학동', 'Home', 'district')).toBe(true);
    expect(implausibleEnglishTranslation('학동', 'Home')).toBe(false);
    expect(usableAddressTranslation('Home', 'en', '학동', 'dependentLocality')).toBe(false);
  });
});

describe('English street types in Chinese', () => {
  it('writes abbreviated types out for providers and leaves other names alone', () => {
    expect(expandEnglishStreetType('Carson DR')).toBe('Carson Drive');
    expect(expandEnglishStreetType('Madigan DR NE')).toBe('Madigan Drive NE');
    expect(expandEnglishStreetType('St Kilda Road')).toBe('St Kilda Road');
    expect(expandEnglishStreetType('HWY 128')).toBe('HWY 128');
    expect(expandEnglishStreetType('ST')).toBe('ST');
  });

  it.each([
    ['Orchard Close', '果园关闭', '果园巷'],
    ['Park View Close', '公园景观 关闭', '公园景观巷'],
    ['Mill Lane Close', '米尔巷关闭', '米尔巷'],
    ['Paul Close', '保罗·克洛斯', '保罗巷'],
    ['Carson DR', '卡森博士', '卡森大道'],
    ['Marine DR', '海洋灾难恢复', '海洋大道'],
    ['Madigan Drive NE', '马迪根驱动器东北', '马迪根大道东北'],
    ['HOWARD ST', '霍华德·圣', '霍华德街'],
    ['2nd ST', '2nd 意法半导体', '2nd 街'],
    ['JUNIPER CT', '杜松CT', '杜松庭'],
    ['Eaton Terrace', '伊顿露台', '伊顿台'],
    ['Coventry Hills Way NE', '考文垂山方式 NE', '考文垂山路 NE'],
    ['Stratton Drive', '斯特拉顿大道', '斯特拉顿大道'],
    ['Rue de la Paix', '和平街', '和平街'],
    ['Smith Closet', '史密斯衣柜', '史密斯衣柜']
  ])('normalizes %s: %s → %s', (original, translated, expected) => {
    expect(normalizeChineseStreetType(original, translated)).toBe(expected);
    expect(implausibleChineseTranslation(original, expected)).toBe(false);
  });
});
