import { describe, expect, it } from 'vitest';
import { chinaDistrictPostcode } from '../server/china/district-postcodes';

describe('China district postcodes', () => {
  it('uses the adcode only when its names agree and falls back to the province-matched supplement', () => {
    expect(chinaDistrictPostcode({ adcode: '500101', province: '重庆市', district: '万州区' })).toBe('404100');
    expect(chinaDistrictPostcode({ adcode: '110105', province: '河北省', district: '丰润区' })).toBe('064000');
    expect(chinaDistrictPostcode({ adcode: '429004', province: '湖北省', district: '仙桃市' })).toBe('433000');
    expect(chinaDistrictPostcode({ adcode: '469006', province: '海南省', district: '万宁市' })).toBe('571500');
    expect(chinaDistrictPostcode({ adcode: '', province: '广东省', district: '仙桃市' })).toBe('');
  });
});
