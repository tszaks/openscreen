// The 3D phone's finish colours (owner decision 15: "correct Apple finish
// colours from apple.com"). devices.ts keeps its own swatches for the flat
// frame (flat projects must not change); the 3D materials take Apple's.
//
// Source: the colour swatches Apple draws for each model on
// https://www.apple.com/iphone/compare/ (stylesheet
// /v/iphone/compare/an/built/styles/overview.built.css, rules
// `.colornav-wrapper-<model> .colornav-swatch-<finish>{background-color:…}`),
// read 2026-10-25. Apple lists one wrapper per family (e.g. the 17 Pro Max
// for the 17 Pro too, the 16 Plus for the 16). iPads are not on that page:
// they keep devices.ts' swatch.
import type { DeviceModel } from '../../../shared/devices';

/** Apple's swatches, by compare-page wrapper, then finish (Apple's id: the name lowercased, no spaces). */
export const APPLE_SWATCHES: Record<string, Record<string, string>> = {
  'iphone-17-pro-max': { cosmicorange: '#F77E2D', deepblue: '#32374A', silver: '#F5F5F5' },
  'iphone-air': { skyblue: '#F0F9FF', lightgold: '#FFFCF5', cloudwhite: '#FCFCFC', spaceblack: '#000000' },
  'iphone-17': { black: '#353839', white: '#F5F5F5', mistblue: '#96AED1', sage: '#A9B689', lavender: '#DFCEEA' },
  'iphone-16-pro-max': { deserttitanium: '#BFA48F', naturaltitanium: '#C2BCB2', whitetitanium: '#F2F1ED', blacktitanium: '#3C3C3D' },
  'iphone-16-plus': { black: '#3C4042', white: '#FAFAFA', pink: '#F2ADDA', teal: '#B0D4D2', ultramarine: '#9AADF6' },
  'iphone-16e': { black: '#3C4042', white: '#FAFAFA' },
  'iphone-15-pro-max': { naturaltitanium: '#837F7D', bluetitanium: '#2F4452', whitetitanium: '#DDDDDD', blacktitanium: '#1B1B1B' },
  'iphone-15-plus': { black: '#35393B', blue: '#CED5D9', green: '#CAD4C5', yellow: '#E6E0C1', pink: '#E3C8CA' },
  'iphone-14-pro-max': { spaceblack: '#403E3D', silver: '#F0F2F2', gold: '#F4E8CE', deeppurple: '#594F63' },
  'iphone-14-plus': { midnight: '#222930', starlight: '#FAF6F2', blue: '#A0B4C7', purple: '#E6DDEB', red: '#FC0324', yellow: '#F9E479' },
  'iphone-13-pro-max': { graphite: '#54524F', gold: '#FAE7CF', silver: '#F1F2ED', sierrablue: '#A7C1D9', alpinegreen: '#576856' },
  'iphone-13-mini': { midnight: '#232A31', starlight: '#FAF6F2', blue: '#276787', pink: '#FADDD7', green: '#394C38', red: '#BF0013' },
  'iphone-se-3rd-gen': { midnight: '#232A31', starlight: '#FAF6F2', red: '#BF0013' },
};

/** The compare-page wrapper Apple uses for each of our model ids. */
export const APPLE_WRAPPER: Record<string, string> = {
  'iphone-17-pro-max': 'iphone-17-pro-max',
  'iphone-17-pro': 'iphone-17-pro-max',
  'iphone-air': 'iphone-air',
  'iphone-17': 'iphone-17',
  'iphone-16-pro-max': 'iphone-16-pro-max',
  'iphone-16-pro': 'iphone-16-pro-max',
  'iphone-16-plus': 'iphone-16-plus',
  'iphone-16': 'iphone-16-plus',
  'iphone-16e': 'iphone-16e',
  'iphone-15-pro-max': 'iphone-15-pro-max',
  'iphone-15-pro': 'iphone-15-pro-max',
  'iphone-15-plus': 'iphone-15-plus',
  'iphone-15': 'iphone-15-plus',
  'iphone-14-pro-max': 'iphone-14-pro-max',
  'iphone-14-pro': 'iphone-14-pro-max',
  'iphone-14-plus': 'iphone-14-plus',
  'iphone-14': 'iphone-14-plus',
  'iphone-13-pro-max': 'iphone-13-pro-max',
  'iphone-13-pro': 'iphone-13-pro-max',
  'iphone-13': 'iphone-13-mini',
  'iphone-13-mini': 'iphone-13-mini',
  'iphone-se-3': 'iphone-se-3rd-gen',
};

/** Our finish id (devices.ts: "cosmic-orange", "productred") → Apple's ("cosmicorange", "red"). */
export function appleFinishKey(finishId: string): string {
  const k = finishId.replace(/-/g, '');
  return k === 'productred' ? 'red' : k;
}

/** The finish colour the 3D phone is made in: Apple's swatch when the compare page has one, else devices.ts'. */
export function finish3dHex(device: Pick<DeviceModel, 'id'>, finish: { id: string; hex: string }): string {
  const wrapper = APPLE_WRAPPER[device.id];
  return (wrapper && APPLE_SWATCHES[wrapper]?.[appleFinishKey(finish.id)]) ?? finish.hex;
}
