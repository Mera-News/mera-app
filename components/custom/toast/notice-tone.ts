import {
    Bell,
    Brush,
    Clock,
    Cloud,
    MessageCircleQuestionMark,
    RotateCw,
    ShieldAlert,
    ShieldCheck,
    SlidersHorizontal,
    Smartphone,
    Star,
    WandSparkles,
    type LucideIcon,
} from 'lucide-react-native';
import type { ToastTone } from './MeraToast';

export interface NoticeLook {
    tone: ToastTone;
    icon: LucideIcon;
}

/**
 * THE ONE MAP from an inbox notice's `type` to its tone and glyph, shared by the
 * notice's toast, its inbox row and its sheet, so the three never disagree.
 * Literal type strings, not imports: the writers pull the database in.
 */
const LOOKS: Record<string, NoticeLook> = {
    update_available: { tone: 'info', icon: RotateCw },
    app_updated: { tone: 'neutral', icon: Star },
    calibration: { tone: 'info', icon: SlidersHorizontal },
    hygiene: { tone: 'info', icon: Brush },
    optimisation_plan: { tone: 'info', icon: WandSparkles },
    'on-device-fallback': { tone: 'warning', icon: Cloud },
    move_to_phone: { tone: 'warning', icon: Smartphone },
    feedback_request: { tone: 'neutral', icon: MessageCircleQuestionMark },
    // Never written any more (NOT_KEPT_NOTICE_TYPES); here only so a stray row draws right.
    feed_info: { tone: 'warning', icon: Clock },
};

const FACT_CHECK_TONE: Record<string, ToastTone> = { found: 'success', none: 'info', unavailable: 'warning' };

/** Tone and glyph for a notice; a fact check's follow its outcome, an unknown type is neutral. */
export function noticeLook(type: string, context?: Record<string, unknown> | null): NoticeLook {
    if (type === 'fact_check_done') {
        const outcome = typeof context?.outcome === 'string' ? context.outcome : '';
        return { tone: FACT_CHECK_TONE[outcome] ?? 'info', icon: outcome === 'unavailable' ? ShieldAlert : ShieldCheck };
    }
    return LOOKS[type] ?? { tone: 'neutral', icon: Bell };
}
