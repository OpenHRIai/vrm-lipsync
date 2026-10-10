import type { VRM } from "@pixiv/three-vrm";
import React, {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import type { LipsyncFeed } from "../lipsync/feed";
import { ArticulationSource, isLipsyncSource, type LipsyncSource } from "../lipsync/source";
import type { SmoothingConfig, VisemeMapperConfig } from "../lipsync/visemeMapper";
import { AvatarStage } from "./AvatarStage";
import type { EmotionPreset } from "./controllers/ExpressionController";
import type { LoadProgress } from "./loader";

export interface VRMAvatarProps {
  /** URL of the `.vrm` model. */
  modelUrl: string;
  /**
   * What drives the mouth. Pass a `LipsyncFeed` (see `useLipsyncFeed`) and it
   * is wrapped in an `ArticulationSource`; pass your own `LipsyncSource` to
   * drive the avatar from anything else. Omit for a silent avatar.
   */
  source?: LipsyncFeed | LipsyncSource | null;
  /** Optional `.vrma` idle loop. */
  idleAnimationUrl?: string;
  backgroundColor?: string;
  cameraPosition?: { x: number; y: number; z: number };
  cameraTarget?: { x: number; y: number; z: number };
  /** Tuning for the articulation-to-vowel mapping. */
  mapperConfig?: Partial<VisemeMapperConfig>;
  smoothingConfig?: Partial<SmoothingConfig>;
  /** Enable orbit/zoom camera controls. Off by default. */
  interactive?: boolean;
  /**
   * Scales the scene lights; 1 by default. Below 1 keeps toon-shaded skin
   * from washing out, so mouth shapes read more clearly.
   */
  lightIntensity?: number;
  /**
   * Override the decoder URLs used for Draco/KTX2 compressed models. Point
   * these at self-hosted copies if your CSP blocks the default CDNs.
   */
  dracoDecoderPath?: string;
  ktx2TranscoderPath?: string;
  className?: string;
  style?: React.CSSProperties;
  onLoad?: (vrm: VRM) => void;
  onProgress?: (progress: LoadProgress) => void;
  onError?: (error: Error) => void;
  fallback?: React.ReactNode;
}

export interface VRMAvatarRef {
  setEmotion: (preset: EmotionPreset, duration?: number) => void;
  getVRM: () => VRM | null;
  getStage: () => AvatarStage | null;
}

/**
 * Renders a VRM avatar whose mouth is driven by a Pipecat lipsync feed.
 *
 * The canvas fills its container and follows it via ResizeObserver, and the
 * render loop pauses while the tab is hidden — an offscreen avatar has no
 * reason to hold the GPU.
 */
export const VRMAvatar = memo(
  forwardRef<VRMAvatarRef, VRMAvatarProps>(function VRMAvatar(props, ref) {
    const {
      modelUrl,
      source,
      idleAnimationUrl,
      backgroundColor,
      cameraPosition,
      cameraTarget,
      mapperConfig,
      smoothingConfig,
      dracoDecoderPath,
      ktx2TranscoderPath,
      interactive,
      lightIntensity,
      className,
      style,
      onLoad,
      onProgress,
      onError,
      fallback,
    } = props;

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<AvatarStage | null>(null);
    const [ready, setReady] = useState(false);

    // Callbacks live in a ref so identity changes never re-create the scene.
    const handlers = useRef({ onLoad, onProgress, onError });
    handlers.current = { onLoad, onProgress, onError };
    // Read at scene creation; later changes are applied in place below.
    const lightIntensityRef = useRef(lightIntensity);
    lightIntensityRef.current = lightIntensity;

    useImperativeHandle(
      ref,
      () => ({
        setEmotion: (preset, duration) =>
          stageRef.current?.setEmotion(preset, duration),
        getVRM: () => stageRef.current?.getVRM() ?? null,
        getStage: () => stageRef.current,
      }),
      [],
    );

    // Re-created only when something structural changes. Objects passed by
    // literal (cameraPosition, mapperConfig) are intentionally not deps — a
    // new object each render would thrash the whole scene.
    useEffect(() => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;

      setReady(false);
      const stage = new AvatarStage({
        canvas,
        modelUrl,
        idleAnimationUrl,
        backgroundColor,
        cameraPosition,
        cameraTarget,
        dracoDecoderPath,
        ktx2TranscoderPath,
        interactive,
        lightIntensity: lightIntensityRef.current,
        onProgress: (p) => handlers.current.onProgress?.(p),
      });
      stageRef.current = stage;

      const observer = new ResizeObserver(([entry]) => {
        const { width, height } = entry.contentRect;
        stage.resize(width, height);
      });
      observer.observe(container);
      stage.resize(container.clientWidth, container.clientHeight);

      let cancelled = false;
      stage
        .load()
        .then((vrm) => {
          if (cancelled) return;
          setReady(true);
          stage.start();
          handlers.current.onLoad?.(vrm);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          handlers.current.onError?.(
            err instanceof Error ? err : new Error(String(err)),
          );
        });

      const onVisibility = () => {
        if (document.hidden) stage.stop();
        else stage.start();
      };
      document.addEventListener("visibilitychange", onVisibility);

      return () => {
        cancelled = true;
        document.removeEventListener("visibilitychange", onVisibility);
        observer.disconnect();
        stage.dispose();
        stageRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
      modelUrl,
      idleAnimationUrl,
      backgroundColor,
      dracoDecoderPath,
      ktx2TranscoderPath,
      interactive,
    ]);

    // Applied in place: a slider dragging the light should not reload the model.
    useEffect(() => {
      stageRef.current?.setLightIntensity(lightIntensity ?? 1);
    }, [lightIntensity]);

    // A bare LipsyncFeed is adapted here so the common case stays a one-liner
    // while custom sources bypass the mapper entirely.
    const lipsyncSource = useMemo<LipsyncSource | null>(() => {
      if (!source) return null;
      if (isLipsyncSource(source)) return source;
      return new ArticulationSource(source, { mapperConfig, smoothingConfig });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [source]);

    useEffect(() => {
      stageRef.current?.setSource(lipsyncSource);
    }, [lipsyncSource]);

    return (
      <div
        ref={containerRef}
        className={className}
        style={{ position: "relative", width: "100%", height: "100%", ...style }}
      >
        <canvas
          ref={canvasRef}
          style={{ display: "block", width: "100%", height: "100%" }}
        />
        {!ready && fallback}
      </div>
    );
  }),
);

export default VRMAvatar;
