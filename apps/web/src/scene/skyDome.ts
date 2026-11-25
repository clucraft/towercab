import { EARTH_RADIUS_M } from '@towercab/shared';
import {
  BlendingState,
  type Camera,
  Cartesian3,
  Color,
  CustomShader,
  EllipsoidGeometry,
  GeometryInstance,
  Material,
  MaterialAppearance,
  Matrix4,
  Primitive,
  type Scene,
  UniformType,
} from 'cesium';
import type { Rgb, SkyLook } from './sky';

/** Beyond everything that is drawn: from as far out as the camera goes, the horizon is some 1,200 km away. */
const RADIUS_M = 2e7;

const SOURCE = `
uniform vec4 zenith;
uniform vec4 horizon;
uniform vec4 sunward;
uniform vec4 glow;
uniform vec4 disc;
uniform vec3 up;
uniform vec3 sun;
uniform float opacity;
uniform float dim;
uniform float dip;

czm_material czm_getMaterial(czm_materialInput materialInput)
{
  czm_material material = czm_getDefaultMaterial(materialInput);
  vec3 dir = normalize(czm_inverseViewRotation * -materialInput.positionToEyeEC);
  float height = dot(dir, up);

  // How much this direction points the way the sun is, along the horizon.
  vec3 flatDir = dir - up * height;
  vec3 flatSun = sun - up * dot(sun, up);
  float toward = 0.5 + 0.5 * dot(flatDir, flatSun) / max(length(flatDir) * length(flatSun), 0.0001);
  toward *= toward * toward;

  // From high up the horizon lies lower than straight ahead.
  float rise = height + dip;
  float low = max(rise, 0.0);
  vec3 color = mix(zenith.rgb, horizon.rgb, exp(-low * 4.5));
  color = mix(color, sunward.rgb, toward * exp(-low * 8.0));

  // Light upon light, which gets close to white and never past it.
  float angle = max(dot(dir, sun), 0.0);
  color = 1.0 - (1.0 - color) * (1.0 - glow.rgb * (0.3 * pow(angle, 14.0) + 0.7 * pow(angle, 220.0)));

  // Twice as wide as the sun is, for what glare does to the eye. A sine keeps more digits of so small an angle than
  // a cosine would.
  float off = angle > 0.0 ? length(cross(dir, sun)) : 1.0;
  color = mix(color, disc.rgb, disc.a * (1.0 - smoothstep(0.0085, 0.0105, off)) * smoothstep(-0.012, -0.004, rise));

  // A little noise, finer than the steps between colours, or the dark sky would show bands.
  float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  material.diffuse = color * dim + (noise - 0.5) / 255.0;
  material.alpha = opacity;
  return material;
}
`;

/**
 * The sky: a sphere around the camera that is coloured by direction. Behind everything in the depth buffer and never
 * written to it, so what asks where the mouse points is told "nowhere".
 */
export class SkyDome {
  private readonly material: Material;
  private readonly primitive: Primitive;

  constructor(private readonly scene: Scene) {
    this.material = new Material({
      fabric: {
        uniforms: {
          zenith: new Color(),
          horizon: new Color(),
          sunward: new Color(),
          glow: new Color(),
          disc: new Color(),
          up: new Cartesian3(0, 0, 1),
          sun: new Cartesian3(0, 0, 1),
          opacity: 1,
          dim: 1,
          dip: 0,
        },
        source: SOURCE,
      },
      translucent: false,
    });
    const geometry = EllipsoidGeometry.createGeometry(
      new EllipsoidGeometry({
        radii: new Cartesian3(RADIUS_M, RADIUS_M, RADIUS_M),
        stackPartitions: 16,
        slicePartitions: 24,
        vertexFormat: MaterialAppearance.MaterialSupport.BASIC.vertexFormat,
      }),
    );
    const appearance = new MaterialAppearance({
      material: this.material,
      materialSupport: MaterialAppearance.MaterialSupport.BASIC,
      flat: true,
      translucent: false,
      closed: false,
    });
    // Cesium has opaque things write depth, whatever it is told. A sky that does is somewhere: 20,000 km away, and
    // a notch of the wheel over it moves the camera more than a kilometre. A translucent one would not write it, but is
    // blended with the trails as if it were between them.
    appearance.getRenderState = () => ({
      cull: { enabled: false },
      depthTest: { enabled: true },
      depthMask: false,
      blending: BlendingState.ALPHA_BLEND,
    });
    this.primitive = scene.primitives.add(
      new Primitive({
        geometryInstances: geometry ? new GeometryInstance({ geometry }) : undefined,
        appearance,
        asynchronous: false,
        allowPicking: false,
        cull: false,
      }),
    ) as Primitive;
  }

  set show(show: boolean) {
    this.primitive.show = show;
  }

  /** Keeps the sphere around the camera. Called for every frame. */
  follow(camera: Camera): void {
    Matrix4.fromTranslation(camera.positionWC, this.primitive.modelMatrix);
    const down = EARTH_RADIUS_M / (EARTH_RADIUS_M + Math.max(0, camera.positionCartographic.height));
    this.material.uniforms.dip = Math.sqrt(1 - down * down);
  }

  /** `dim` darkens all of it, for the Schematic map; `sun` and `up` are unit vectors in world coordinates. */
  set(look: SkyLook, sun: Cartesian3, up: Cartesian3, dim: number): void {
    const { uniforms } = this.material;
    put(uniforms.zenith, look.zenith);
    put(uniforms.horizon, look.horizon);
    put(uniforms.sunward, look.sunward);
    put(uniforms.glow, look.glow);
    put(uniforms.disc, look.disc, Math.min(1, Math.max(...look.disc) * 1.5));
    Cartesian3.clone(sun, uniforms.sun);
    Cartesian3.clone(up, uniforms.up);
    uniforms.opacity = dim < 1 ? 1 : look.opacity;
    uniforms.dim = dim;
  }

  destroy(): void {
    this.scene.primitives.remove(this.primitive);
  }
}

function put(color: Color, rgb: Rgb, alpha = 1): void {
  Color.clone(new Color(...rgb, alpha), color);
}

/**
 * Darkens Google's tiles. Their light is in the picture, which was taken by day, so there is nothing else to turn
 * down. One shader for all tiles and all hours: putting one on or taking it off would prepare every tile anew.
 */
export class GroundLight {
  readonly shader = new CustomShader({
    uniforms: {
      u_light: { type: UniformType.VEC3, value: new Cartesian3(1, 1, 1) },
      u_grey: { type: UniformType.FLOAT, value: 0 },
    },
    fragmentShaderText: `
      void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material)
      {
        float grey = dot(material.diffuse, vec3(0.2126, 0.7152, 0.0722));
        material.diffuse = mix(material.diffuse, vec3(grey), u_grey) * u_light;
      }
    `,
  });

  set(look: SkyLook): void {
    // The shader works on light, and the colours of `SkyLook` are as displayed.
    const [r, g, b] = look.ground.map((v) => v ** 2.2) as [number, number, number];
    this.shader.setUniform('u_light', new Cartesian3(r, g, b));
    this.shader.setUniform('u_grey', look.groundGrey);
  }
}
