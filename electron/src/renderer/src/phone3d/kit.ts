// The phone kit the engine renders (SPEC §3.1-§3.4, D13): the procedural
// phone from geometry.ts with materials.ts' finish, environment.ts' hero
// softboxes (RectAreaLights) and its PMREM fill. The engine owns what this
// makes (its LRUs dispose it), so nothing here goes through the module
// caches the turntable tool uses.
import * as THREE from 'three';
import type { LightPreset } from '../../../shared/phone3d/model';
import type { Scene3D } from '../../../shared/phone3d/projection';
import { createStudioEnv, scaleStudio, setLightIntensity, studioLights } from './environment';
import { createPhone, disposePhone } from './geometry';
import { applyMaterials, materialsForDevice } from './materials';

/** A built phone: the model in mm (portrait, y up, front +z, centred, front glass on z = depth/2). */
export interface PhoneModel {
  root: THREE.Object3D;
  /**
   * The screen mesh. Its material is a MeshBasicMaterial (toneMapped false)
   * with the mrtOutput 'screen' and lodBias patches; its UVs are planar, u
   * along +x and v along +y (up), 0..1 over the screen outline; it lies ON
   * the front glass plane (z = depth/2) as an overlay layer (polygonOffset),
   * so at FRONT it projects exactly onto the flat screen rect and the screen
   * texture stays texel exact.
   */
  screen: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  dispose(): void;
}

export interface PhoneLook {
  /** Finish hex (devices.ts getFinish). */
  hex: string;
  back: 'auto' | 'glossy' | 'frosted';
  glass: number;
}

/** A light rig and how to put it around the phone for one sample. */
export interface PhoneKit {
  /** The phone for this scene's device and look. Every material in it has an mrtOutput patch. */
  phone(s: Scene3D, look: PhoneLook, renderer: THREE.WebGLRenderer): PhoneModel;
  /** The preset's hero softboxes, scaled by intensity, at azimuth 0 (the engine aims them per sample). */
  lights(preset: LightPreset, intensity: number): THREE.Object3D;
  /** Centres the rig on the phone (world units) and sizes it for a body long side of `unit` world units. */
  placeLights(rig: THREE.Object3D, center: readonly [number, number, number], unit: number): void;
  /** The PMREM fill for a preset and the background's mean linear colour, owned by the caller. */
  environment(preset: LightPreset, bgMean: readonly [number, number, number], renderer: THREE.WebGLRenderer): { texture: THREE.Texture; dispose(): void } | null;
  /** scene.environmentIntensity = light.intensity × this. */
  envStrength(preset: LightPreset): number;
}

export const STUDIO_KIT: PhoneKit = {
  phone(s, look, renderer) {
    const device = s.home.device;
    const body = s.body3d;
    const model = createPhone(device, body);
    const mats = materialsForDevice(device, body, look.hex, look.back, look.glass, {
      reversedDepth: renderer.state.buffers.depth.getReversed(),
      cached: false,
    });
    applyMaterials(model.group, mats);
    let screen: PhoneModel['screen'] | null = null;
    model.group.traverse((o) => {
      if (o.userData.part === 'screen' && o instanceof THREE.Mesh) screen = o as PhoneModel['screen'];
    });
    if (!screen) throw new Error(`phone3d: ${device.id} has no screen mesh`);
    return {
      root: model.group,
      screen,
      dispose() {
        disposePhone(model);
        for (const m of mats.all) m.dispose();
      },
    };
  },
  lights(preset, intensity) {
    const g = studioLights(preset, 1, 1);
    setLightIntensity(g, intensity);
    return g;
  },
  placeLights(rig, center, unit) {
    scaleStudio(rig as THREE.Group, center, unit);
  },
  environment(preset, bgMean, renderer) {
    const target = createStudioEnv(renderer, preset, bgMean);
    return { texture: target.texture, dispose: () => target.dispose() };
  },
  // The fill's radiance is already the preset's (environment.ts): intensity 1.
  envStrength: () => 1,
};
