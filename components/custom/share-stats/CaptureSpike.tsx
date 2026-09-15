// CaptureSpike — P0 of the Mera Stats share card. THROWAWAY.
//
// react-native-view-shot 4.0.3 is banked in the binary but has ZERO first-party
// callers: the only reference in the repo is the jest mock. A green build and a
// type declaration are not runtime proof, so this screen exists to answer four
// questions on a real simulator before any card is built, and is deleted once
// they are answered:
//
//   1. Does `captureRef` return a usable file URI under Fabric with
//      `reactCompiler: true`?
//   2. Do the `width`/`height` options mean PIXELS of the output image, or are
//      they points that get multiplied by the device scale? The plan needs
//      exactly 1080x1920 out of the capture call, and `expo-image-manipulator`
//      is NOT installed, so there is no post-capture resize to fall back on.
//   3. Does a host positioned OFF-SCREEN but still laid out capture correctly?
//      (`display: none` and unmounted trees capture as nothing.)
//   4. Do Devanagari and Arabic render in the captured bitmap, and does RTL lay
//      out sanely? The app ships 20 locales.
//
// It captures three ways so the answer to (2) is a measurement rather than an
// inference, and reads the decoded dimensions back OFF THE PNG with
// `Image.getSize` rather than trusting the options object.
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { File } from 'expo-file-system';
import React, { useCallback, useRef, useState } from 'react';
import { Image, PixelRatio, Platform, Pressable, ScrollView, Text as RNText, View } from 'react-native';
import { captureRef } from 'react-native-view-shot';

/** 9:16 at a comfortable authoring size — the ratio the card ships at. */
const SMALL_W = 360;
const SMALL_H = 640;
/** 9:16 at the export size, in points, so a capture can DOWNscale to 1080x1920. */
const LARGE_W = 1080;
const LARGE_H = 1920;

const TARGET_W = 1080;
const TARGET_H = 1920;

/** Devanagari and Arabic samples. The Arabic block is marked RTL so the spike
 *  also shows whether direction survives into the bitmap. */
const HINDI = 'मेरा न्यूज़ · पिछले 30 दिन';
const ARABIC = 'ميرا نيوز · آخر 30 يوما';

interface CaptureResult {
    label: string;
    uri: string;
    decodedWidth: number | null;
    decodedHeight: number | null;
    bytes: number | null;
    error: string | null;
}

/** `captureRef` has returned a bare path rather than a `file://` URI on iOS in
 *  past versions. Normalise before handing it to `Image.getSize`, and report the
 *  RAW string separately so we learn which shape this version returns. */
function toLoadableUri(uri: string): string {
    if (uri.startsWith('file://') || uri.startsWith('http') || uri.startsWith('data:')) return uri;
    return `file://${uri}`;
}

function decodeSize(uri: string): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
        Image.getSize(uri, (width, height) => resolve({ width, height }), reject);
    });
}

function byteSize(uri: string): number | null {
    try {
        const file = new File(toLoadableUri(uri));
        return file.exists ? (file.size ?? null) : null;
    } catch {
        return null;
    }
}

/** The thing being captured. Built from the real Gluestack + NativeWind
 *  vocabulary the card will use, not from throwaway primitives, so a capture
 *  failure specific to those components shows up here rather than in P2. */
const SpikeCanvas: React.FC<{ scale: number }> = ({ scale }) => (
    <Box className="flex-1 bg-black" style={{ padding: 32 * scale }}>
        <VStack className="flex-1 justify-between">
            <VStack space="sm">
                <Text className="text-typography-0 font-semibold" style={{ fontSize: 34 * scale }}>
                    mera news
                </Text>
                <Text className="text-gray-400" style={{ fontSize: 18 * scale }}>
                    Last 30 days
                </Text>
            </VStack>

            <VStack space="md">
                <Text className="text-typography-0 font-semibold" style={{ fontSize: 96 * scale }}>
                    42
                </Text>
                <Text className="text-typography-0" style={{ fontSize: 22 * scale }}>
                    {HINDI}
                </Text>
                <Text
                    className="text-typography-0"
                    style={{ fontSize: 22 * scale, writingDirection: 'rtl', textAlign: 'right' }}
                >
                    {ARABIC}
                </Text>
            </VStack>

            <Box className="rounded-lg border border-white" style={{ padding: 12 * scale }}>
                <Text className="text-typography-0" style={{ fontSize: 16 * scale }}>
                    Latin baseline 123 · ABC
                </Text>
            </Box>
        </VStack>
    </Box>
);

const CaptureSpike: React.FC<{ onBack: () => void }> = ({ onBack }) => {
    const smallRef = useRef<View>(null);
    const largeRef = useRef<View>(null);
    const [results, setResults] = useState<CaptureResult[]>([]);
    const [running, setRunning] = useState(false);

    const runOne = useCallback(
        async (
            label: string,
            ref: React.RefObject<View | null>,
            options: Parameters<typeof captureRef>[1],
        ): Promise<CaptureResult> => {
            const base: CaptureResult = {
                label,
                uri: '',
                decodedWidth: null,
                decodedHeight: null,
                bytes: null,
                error: null,
            };
            try {
                const raw = await captureRef(ref as never, options);
                const uri = String(raw);
                const size = await decodeSize(toLoadableUri(uri)).catch(() => null);
                return {
                    ...base,
                    uri,
                    decodedWidth: size?.width ?? null,
                    decodedHeight: size?.height ?? null,
                    bytes: byteSize(uri),
                };
            } catch (error) {
                return { ...base, error: error instanceof Error ? error.message : String(error) };
            }
        },
        [],
    );

    const run = useCallback(async () => {
        setRunning(true);
        setResults([]);
        const out: CaptureResult[] = [];
        // A: small host, explicit target dimensions. The cheap option, and the
        //    one the plan assumes works.
        out.push(
            await runOne('A small-host-target', smallRef, {
                width: TARGET_W,
                height: TARGET_H,
                format: 'png',
                result: 'tmpfile',
            }),
        );
        // B: host laid out AT the export size, same explicit target. Crisp on
        //    every device scale, but 1080x1920 points of layout.
        out.push(
            await runOne('B large-host-target', largeRef, {
                width: TARGET_W,
                height: TARGET_H,
                format: 'png',
                result: 'tmpfile',
            }),
        );
        // C: small host, NO dimensions. Tells us what the default is, which is
        //    what separates "options are pixels" from "options are points".
        out.push(
            await runOne('C small-host-natural', smallRef, {
                format: 'png',
                result: 'tmpfile',
            }),
        );
        setResults(out);
        setRunning(false);
    }, [runOne]);

    return (
        <View style={{ flex: 1, backgroundColor: '#000000' }}>
            {/* The offscreen hosts. Positioned off to the left, NOT hidden:
                `display: none` and an unmounted tree capture as nothing.
                `collapsable={false}` keeps Android from flattening the view out
                of the hierarchy, which would leave nothing to snapshot. */}
            <View
                ref={smallRef}
                collapsable={false}
                style={{ position: 'absolute', left: -8000, top: 0, width: SMALL_W, height: SMALL_H }}
            >
                <SpikeCanvas scale={1} />
            </View>
            <View
                ref={largeRef}
                collapsable={false}
                style={{ position: 'absolute', left: -8000, top: 0, width: LARGE_W, height: LARGE_H }}
            >
                <SpikeCanvas scale={LARGE_W / SMALL_W} />
            </View>

            <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 64 }}>
                <Pressable onPress={onBack} testID="share-stats-spike-back" hitSlop={12}>
                    <RNText style={{ color: '#9CA3AF', fontSize: 14 }}>Back</RNText>
                </Pressable>

                <RNText style={{ color: '#FFFFFF', fontSize: 20, fontWeight: '600', marginTop: 16 }}>
                    view-shot spike
                </RNText>
                <RNText testID="share-stats-spike-env" style={{ color: '#9CA3AF', fontSize: 13, marginTop: 6 }}>
                    {`platform=${Platform.OS} pixelRatio=${PixelRatio.get()} target=${TARGET_W}x${TARGET_H} smallHost=${SMALL_W}x${SMALL_H} largeHost=${LARGE_W}x${LARGE_H}`}
                </RNText>

                <Pressable
                    onPress={run}
                    disabled={running}
                    testID="share-stats-spike-run"
                    style={{
                        marginTop: 20,
                        paddingVertical: 14,
                        borderRadius: 10,
                        borderWidth: 1,
                        borderColor: '#FFFFFF',
                        alignItems: 'center',
                    }}
                >
                    <RNText style={{ color: '#FFFFFF', fontSize: 16, fontWeight: '600' }}>
                        {running ? 'Capturing...' : 'Run capture'}
                    </RNText>
                </Pressable>

                <RNText
                    testID="share-stats-spike-result"
                    selectable
                    style={{ color: '#FFFFFF', fontSize: 13, marginTop: 20, lineHeight: 20 }}
                >
                    {results.length === 0
                        ? 'NO RESULT YET'
                        : results
                              .map((r) =>
                                  r.error
                                      ? `${r.label}: ERROR ${r.error}`
                                      : `${r.label}: decoded=${r.decodedWidth}x${r.decodedHeight} bytes=${r.bytes} uri=${r.uri}`,
                              )
                              .join('\n\n')}
                </RNText>

                {/* Rendering the captured PNGs back on screen is the only way to
                    see whether the Devanagari and Arabic glyphs actually made it
                    into the bitmap: a green URI proves a file exists, not that
                    text was rasterised into it. */}
                {results
                    .filter((r) => !r.error && r.uri)
                    .map((r) => (
                        <View key={r.label} style={{ marginTop: 20 }}>
                            <RNText style={{ color: '#9CA3AF', fontSize: 12, marginBottom: 6 }}>
                                {r.label}
                            </RNText>
                            <Image
                                testID={`share-stats-spike-preview-${r.label.split(' ')[0]}`}
                                source={{ uri: toLoadableUri(r.uri) }}
                                style={{ width: 180, height: 320, borderWidth: 1, borderColor: '#374151' }}
                                resizeMode="contain"
                            />
                        </View>
                    ))}
            </ScrollView>
        </View>
    );
};

export default CaptureSpike;
