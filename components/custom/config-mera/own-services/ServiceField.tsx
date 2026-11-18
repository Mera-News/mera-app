import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { useColors } from '@/lib/theme/tokens';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TextInput, View } from 'react-native';

type Props = {
    readonly label: string;
    readonly value: string;
    readonly onChangeText: (text: string) => void;
    /** `address` takes the URL keyboard, `key` hides its text until Show key, `code` is a one-time code in capitals. */
    readonly kind: 'address' | 'text' | 'key' | 'code';
    readonly error?: string | null;
    readonly testID: string;
};

/** A label above its field. A key field is secure by default, with a Show key toggle. */
export function ServiceField({ label, value, onChangeText, kind, error, testID }: Props) {
    const { t } = useTranslation();
    const colors = useColors();
    const [shown, setShown] = useState(false);
    const off =
        kind === 'code'
            ? ({ autoCapitalize: 'characters', autoCorrect: false, autoComplete: 'one-time-code', textContentType: 'oneTimeCode' } as const)
            : ({ autoCapitalize: 'none', autoCorrect: false, autoComplete: 'off', textContentType: 'none', importantForAutofill: 'no' } as const);
    return (
        <View style={{ marginTop: 14 }}>
            <Text style={{ color: colors.ink2, fontSize: 13, fontWeight: '600', marginBottom: 6, marginHorizontal: 4 }}>{label}</Text>
            <View
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: error ? colors.negative : colors.line,
                    backgroundColor: colors.surface,
                    paddingStart: 14,
                }}
            >
                <TextInput
                    testID={testID}
                    value={value}
                    onChangeText={onChangeText}
                    accessibilityLabel={label}
                    accessibilityHint={error ?? undefined}
                    placeholderTextColor={colors.ink3}
                    style={{ flex: 1, minHeight: 48, color: colors.ink, fontSize: 16 }}
                    keyboardType={kind === 'address' ? 'url' : 'default'}
                    secureTextEntry={kind === 'key' && !shown}
                    {...off}
                />
                {kind === 'key' ? (
                    <Pressable
                        testID={`${testID}-toggle`}
                        onPress={() => setShown((s) => !s)}
                        accessibilityRole="button"
                        accessibilityLabel={shown ? t('ownServices.field.hideKey') : t('ownServices.field.showKey')}
                        style={{ minHeight: 48, minWidth: 48, paddingHorizontal: 12, justifyContent: 'center' }}
                    >
                        <Text style={{ color: colors.accentText, fontSize: 14, fontWeight: '600' }}>
                            {shown ? t('ownServices.field.hideKey') : t('ownServices.field.showKey')}
                        </Text>
                    </Pressable>
                ) : null}
            </View>
            {error ? (
                <Text accessibilityLiveRegion="polite" style={{ color: colors.negative, fontSize: 13, lineHeight: 18, marginTop: 6, marginHorizontal: 4 }}>{error}</Text>
            ) : null}
        </View>
    );
}
