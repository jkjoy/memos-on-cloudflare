import { ChevronDown, ChevronUp } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useTranslate } from "@/utils/i18n";

// A collapsed section shows this much content; anything taller folds behind a fade.
export const CLAMP_PREVIEW_HEIGHT_PX = 360;
// Only fold when content is taller than this, so cards barely over the preview aren't
// clamped for the sake of a few hidden pixels.
export const CLAMP_TRIGGER_HEIGHT_PX = 420;

interface ClampedSectionProps {
  /** When false, children render untouched with no measurement. */
  enabled: boolean;
  children: ReactNode;
}

/**
 * The one truncation mechanism for compact cards: measure the content after the
 * initial layout and media load events, and when it is tall enough, collapse it to a
 * fixed-height preview with a fade and a Show more/less toggle. Media events are
 * observed only while they load; the content is not kept under a live resize observer.
 */
const ClampedSection = ({ enabled, children }: ClampedSectionProps) => {
  const t = useTranslate();
  const measureRef = useRef<HTMLDivElement>(null);
  const [clamped, setClamped] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const el = measureRef.current;
    if (!enabled || !el) {
      setClamped(false);
      return;
    }

    let animationFrame = 0;
    const measure = () => {
      animationFrame = 0;
      setClamped(el.offsetHeight > CLAMP_TRIGGER_HEIGHT_PX);
    };
    const scheduleMeasure = () => {
      if (animationFrame) {
        cancelAnimationFrame(animationFrame);
      }
      animationFrame = requestAnimationFrame(measure);
    };

    // Lazy media has no intrinsic height during the first layout pass. Listen for
    // the finite set of media load events so the clamp can react without keeping a
    // ResizeObserver alive for every memo in the feed.
    const mediaElements = el.querySelectorAll("img, iframe, video");
    mediaElements.forEach((media) => {
      media.addEventListener("load", scheduleMeasure);
      media.addEventListener("loadedmetadata", scheduleMeasure);
    });

    measure();
    // Also cover cached media that completed before the listeners were attached.
    scheduleMeasure();

    return () => {
      if (animationFrame) {
        cancelAnimationFrame(animationFrame);
      }
      mediaElements.forEach((media) => {
        media.removeEventListener("load", scheduleMeasure);
        media.removeEventListener("loadedmetadata", scheduleMeasure);
      });
    };
  }, [enabled]);

  const collapsed = clamped && !expanded;

  return (
    <>
      <div
        className={cn("relative w-full", collapsed && "overflow-hidden")}
        style={collapsed ? { maxHeight: CLAMP_PREVIEW_HEIGHT_PX } : undefined}
      >
        <div ref={measureRef} className="w-full flex flex-col justify-start items-start gap-2">
          {children}
        </div>
        {collapsed && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-linear-to-t from-card from-0% via-card/60 via-40% to-transparent to-100%" />
        )}
      </div>
      {clamped && (
        <button
          type="button"
          className="inline-flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setExpanded((prev) => !prev)}
        >
          <span>{t(collapsed ? "memo.show-more" : "memo.show-less")}</span>
          {collapsed ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
        </button>
      )}
    </>
  );
};

export default ClampedSection;
