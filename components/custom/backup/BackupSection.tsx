// Backup and restore, one screen (FinalBackup #1-#12, You > Settings > Your
// data > Backup). Two cards, each a stack of steps that open one below the
// other (the kit's StepsAccordion): Backup on top, Restore always last.
//
// **Backup is optional and stays off.** `backup_cadence` defaults to `off` and
// `backup_provider` to null, so nothing runs until the reader turns it on.
//
// **The RECOVERY CODE COMES FIRST.** `runBackup` refuses until the code is
// acknowledged, because a backup taken before then is written under a key
// that exists only in the keychain, and the next logout wipes the keychain,
// leaving a file nobody can ever open. A provider-first order would end at a
// button the service declines.
//
// **Every destination can be written to unattended.** A save-to-a-file
// destination was built and removed: a share sheet needs a human, so it could
// never be automated, and a backup nobody remembers to take is not a backup.
//
// **The backup itself does NOT run here.** It runs in the OS background task
// (`lib/background/backup-task.ts`). Back up now is the only foreground path
// that does real work. Every path that runs a backup stamps it
// (`recordBackupRun` / `recordBackupFailure`): the status line reads nothing
// else.
//
// **Restore** (its own card, always on screen): where the backup is (Mera
// lists it there first), then the recovery code (adopted as this phone's
// key; the importer refuses a wrong key before touching any data), then a
// confirm (a restore REPLACES), then progress. It never turns backup on for
// this phone (owner, FinalBackup #12). After it the app restarts so every
// store re-hydrates; the toast before the restart may not survive it.
//
// `useTranslation()`'s `t` is read through a ref in callbacks: an unstable
// identity in a dependency list once re-ran the load effect on every render
// and snapped setup back to its first step.

import { useRestartHold } from '@/lib/app-restart';
import LottieView from 'lottie-react-native';
import React from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { MaterialIcons } from '@expo/vector-icons';

import { Group, Help, Row } from '@/components/custom/you/rows';
import { gameAnimationFor } from '@/components/custom/game-ui/animation-registry';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { StepsAccordion, type AccordionStep } from '@/components/ui/steps-accordion';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';

import { backupCadence, backupLastFailedAt, backupLastRunAt, backupProviderId, type BackupProviderId } from '@/lib/backup/backup-settings';
import { isGoogleDriveConfigured } from '@/lib/backup/providers/google-drive';
import { isICloudSupported } from '@/lib/backup/providers/icloud';
import type { BackupCadence } from '@/lib/backup/types';
import { useBackupSection, type BackupStep, type RestoreStep } from './useBackupSection';
import { useColors, useThemeMode } from '@/lib/theme/tokens';
import { useMotionAllowed } from '@/lib/motion-gate';

/** Past this, the status card says the copy is old (FinalBackup #8: a week). */
export const STALE_BACKUP_MS = 7 * 24 * 60 * 60 * 1000;

const CADENCES: Exclude<BackupCadence, 'off'>[] = ['daily', 'weekly', 'manual'];

/** Date and time in the APP language; the bare default if the tag throws. */
function formatWhen(ms: number, language: string | undefined): string {
  try {
    return new Date(ms).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return new Date(ms).toLocaleString();
  }
}

function formatDay(ms: number, language: string | undefined): string {
  try {
    return new Date(ms).toLocaleDateString(language, { day: 'numeric', month: 'short' });
  } catch {
    return new Date(ms).toLocaleDateString();
  }
}

export interface BackupSectionProps {
  /** Open the Restore steps at once (`you/backup?restore=1`, old links). */
  autoOpenRecover?: boolean;
}

const BackupSection: React.FC<BackupSectionProps> = ({ autoOpenRecover = false }) => {
  const { t, i18n } = useTranslation();
  const language = i18n?.language;
  const colors = useColors();
  const themeMode = useThemeMode();
  // Lite / Reduce Motion: no earned-moment animation at all.
  const motion = useMotionAllowed();
  const {
    state,
    step,
    editing,
    setEditing,
    code,
    codeSaved,
    setCodeSaved,
    pickedProvider,
    setPickedProvider,
    pickedCadence,
    setPickedCadence,
    busy,
    icloudReady,
    driveReady,
    bgAvailable,
    showCode,
    setShowCode,
    earned,
    setEarned,
    cloudLastAt,
    refresh,
    onSwitch,
    acknowledgeCode,
    confirmProvider,
    finishCadence,
    backUpNow,
    openRecoveryCode,
    shareCode,
    rstep,
    setRstep,
    rsource,
    setRsource,
    found,
    setFound,
    typedCode,
    setTypedCode,
    restored,
    lookForBackup,
    restore,
  } = useBackupSection({ autoOpenRecover });
  useRestartHold(typedCode.trim().length > 0, 'draft:backup-code', 'hard');

  // ── rendering ─────────────────────────────────────────────────────────────
  const choice = (
    id: string,
    title: string,
    hint: string,
    selected: boolean,
    onPress: () => void,
    disabled = false,
  ) => (
    <Pressable
      key={id}
      testID={id}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityState={{ selected, checked: selected, disabled }}
      accessibilityLabel={`${title}, ${hint}`}
      style={[
        styles.choice,
        { borderColor: selected ? colors.accent : colors.trackBorder, opacity: disabled ? 0.45 : 1 },
      ]}
    >
      <MaterialIcons
        name={selected ? 'radio-button-checked' : 'radio-button-unchecked'}
        size={20}
        color={selected ? colors.accent : colors.ink3}
      />
      <View style={{ flex: 1 }}>
        <Text style={{ color: colors.ink, fontSize: 15, fontWeight: '600' }}>{title}</Text>
        <Text style={{ color: colors.ink2, fontSize: 13, lineHeight: 18 }}>{hint}</Text>
      </View>
    </Pressable>
  );

  const primary = (label: string, onPress: () => void, disabled: boolean, testID: string, spin = false) => (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      // Disabled is neutral grey, never a dimmed accent (components/ui/button).
      style={[styles.primary, { backgroundColor: disabled ? colors.surfaceRaised : colors.accent }]}
    >
      {spin ? (
        <Spinner size="small" />
      ) : (
        <Text style={{ color: disabled ? colors.ink3 : colors.onAccent, fontSize: 16, fontWeight: '600' }}>{label}</Text>
      )}
    </Pressable>
  );

  const codeBox = () => (
    <View style={[styles.codeBox, { backgroundColor: colors.surfaceRaised, borderColor: colors.line }]}>
      <Text selectable style={{ color: colors.ink, textAlign: 'center', fontFamily: 'monospace', lineHeight: 26 }}>
        {code ?? ''}
      </Text>
    </View>
  );

  const providerChoices = (selected: BackupProviderId | null, onPick: (id: BackupProviderId) => void, forRestore: boolean) => (
    <>
      {/* iCloud on Android is not an option at all; iCloud signed out shows
          greyed with what to do (FinalBackup #7). */}
      {isICloudSupported()
        ? choice(
            forRestore ? 'restore-pick-icloud' : 'backup-pick-icloud',
            t('backup.icloud'),
            !icloudReady ? t('backup.icloudUnavailable') : forRestore ? t('backup.restoreSourceIcloud') : t('backup.icloudReady'),
            selected === 'icloud',
            () => onPick('icloud'),
            !icloudReady,
          )
        : null}
      {isGoogleDriveConfigured()
        ? choice(
            forRestore ? 'restore-pick-drive' : 'backup-pick-drive',
            t('backup.drive'),
            forRestore ? t('backup.restoreSourceDrive') : driveReady ? t('backup.driveReady') : t('backup.driveConnect'),
            selected === 'google-drive',
            () => onPick('google-drive'),
          )
        : null}
    </>
  );

  const providerName = (id: BackupProviderId | null) => (id === 'icloud' ? t('backup.icloud') : t('backup.drive'));
  const cadenceName = (c: BackupCadence) => t(`backup.cadence.${c}`);

  const backupSteps = (): AccordionStep[] => {
    const on = state === 'on';
    const statusOf = (s: BackupStep): AccordionStep['status'] => {
      if (on) return editing === s ? 'open' : 'done';
      const order: BackupStep[] = ['code', 'where', 'when'];
      const i = order.indexOf(s);
      const cur = order.indexOf(step);
      return i < cur ? 'done' : i === cur ? 'open' : 'hidden';
    };
    return [
      {
        id: 'code',
        title: t('backup.codeTitle'),
        hint: t('backup.codeDescription'),
        summary: on ? t('backup.codeSavedHint') : t('backup.stepSaved'),
        status: statusOf('code'),
        actionLabel: on ? t('backup.show') : undefined,
        onAction: on ? () => void openRecoveryCode() : undefined,
        children: (
          <View style={{ gap: 10 }}>
            {codeBox()}
            <Pressable testID="backup-share-code" onPress={shareCode} accessibilityRole="button" style={styles.link}>
              <MaterialIcons name="ios-share" size={18} color={colors.accentText} />
              <Text style={{ color: colors.accentText, fontSize: 15, fontWeight: '600' }}>{t('backup.shareCode')}</Text>
            </Pressable>
            <Pressable
              testID="backup-code-saved"
              onPress={() => setCodeSaved((s) => !s)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: codeSaved }}
              style={styles.check}
            >
              <MaterialIcons
                name={codeSaved ? 'check-box' : 'check-box-outline-blank'}
                size={22}
                color={codeSaved ? colors.accent : colors.ink3}
              />
              <Text style={{ flex: 1, color: colors.ink }}>{t('backup.codeSaved')}</Text>
            </Pressable>
            {primary(t('backup.continue'), () => void acknowledgeCode(), !codeSaved, 'backup-code-continue')}
          </View>
        ),
      },
      {
        id: 'where',
        title: on || statusOf('where') === 'done' ? t('backup.where') : t('backup.whereTitle'),
        hint: t('backup.whereDescription'),
        summary: providerName(backupProviderId() ?? pickedProvider),
        status: statusOf('where'),
        actionLabel: on ? t('backup.change') : undefined,
        onAction: on
          ? () => {
              setPickedProvider(backupProviderId());
              setEditing('where');
            }
          : undefined,
        children: (
          <View style={{ gap: 10 }}>
            {providerChoices(pickedProvider, setPickedProvider, false)}
            {primary(t('backup.continue'), () => void confirmProvider(), !pickedProvider || busy !== null, 'backup-where-continue', busy === pickedProvider)}
          </View>
        ),
      },
      {
        id: 'when',
        title: t('backup.whenTitle'),
        summary: cadenceName(backupCadence()),
        status: statusOf('when'),
        actionLabel: on ? t('backup.change') : undefined,
        onAction: on
          ? () => {
              const c = backupCadence();
              setPickedCadence(c === 'off' ? 'daily' : c);
              setEditing('when');
            }
          : undefined,
        children: (
          <View style={{ gap: 10 }}>
            {CADENCES.map((c) =>
              choice(`backup-cadence-${c}`, cadenceName(c), t(`backup.cadenceHint.${c}`), pickedCadence === c, () => setPickedCadence(c)),
            )}
            {primary(on ? t('common.done') : t('backup.finish'), () => void finishCadence(), false, 'backup-finish')}
          </View>
        ),
      },
    ];
  };

  const statusCard = () => {
    const id = backupProviderId() as BackupProviderId;
    const last = backupLastRunAt();
    const failedAt = backupLastFailedAt();
    const age = last !== null ? Date.now() - last : null;
    const warn = { color: colors.warning, fontSize: 13, lineHeight: 18 } as const;
    const plain = { color: colors.ink2, fontSize: 13, lineHeight: 18 } as const;
    return (
      <View testID="backup-status" style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
        <Text style={{ color: colors.ink, fontSize: 16, fontWeight: '600' }}>
          {t('backup.statusProvider', { provider: providerName(id) })}
        </Text>
        <Text style={plain}>{t(id === 'google-drive' ? 'backup.driveHiddenFolder' : 'backup.icloudHiddenFolder')}</Text>
        {/* Each warning only when true (FinalBackup #8). */}
        {failedAt !== null ? (
          <Text testID="backup-status-failed" style={warn}>
            {t('backup.statusFailed', { when: formatWhen(failedAt, language) })}
          </Text>
        ) : null}
        {last === null ? (
          cloudLastAt !== null ? (
            <Text style={plain}>
              {t('backup.statusFromCloud', { when: formatWhen(cloudLastAt, language), provider: providerName(id) })}
            </Text>
          ) : (
            <Text style={plain}>{t('backup.statusNever')}</Text>
          )
        ) : age !== null && age > STALE_BACKUP_MS ? (
          <Text style={warn}>{t('backup.statusStale', { days: Math.floor(age / (24 * 60 * 60 * 1000)) })}</Text>
        ) : (
          <Text style={plain}>{t('backup.statusLast', { when: formatWhen(last, language) })}</Text>
        )}
        {/* Restricted has to be a SENTENCE: with Background App Refresh off,
            backups never run on their own. */}
        {bgAvailable ? null : <Text style={warn}>{t('backup.backgroundRestricted')}</Text>}
        <Text style={plain}>{t('backup.schedule', { cadence: cadenceName(backupCadence()) })}</Text>
      </View>
    );
  };

  const restoreSteps = (): AccordionStep[] => {
    const order: RestoreStep[] = ['where', 'code', 'restoring'];
    const cur = order.indexOf(rstep);
    const statusOf = (s: RestoreStep): AccordionStep['status'] => {
      const i = order.indexOf(s);
      return i < cur ? 'done' : i === cur ? 'open' : 'hidden';
    };
    const foundSummary = found
      ? [t('backup.foundIn', { place: providerName(found.source) }), found.at !== null ? t('backup.foundDate', { date: formatDay(found.at, language) }) : null]
          .filter(Boolean)
          .join(' · ')
      : '';
    return [
      {
        id: 'where',
        title: t('backup.restoreWhereTitle'),
        hint: t('backup.restoreWhereDescription'),
        summary: foundSummary,
        status: statusOf('where'),
        actionLabel: rstep === 'code' ? t('backup.change') : undefined,
        onAction: rstep === 'code' ? () => setRstep('where') : undefined,
        children: (
          <View style={{ gap: 10 }}>
            {providerChoices(rsource, setRsource, true)}
            {primary(t('backup.continue'), () => void lookForBackup(), !rsource || busy !== null, 'restore-where-continue', busy === 'list')}
          </View>
        ),
      },
      {
        id: 'code',
        title: t('backup.adoptTitle'),
        hint: t('backup.restoreCodeHint'),
        summary: t('backup.accepted'),
        status: statusOf('code'),
        children: (
          <View style={{ gap: 10 }}>
            <TextInput
              testID="restore-code-input"
              value={typedCode}
              onChangeText={setTypedCode}
              placeholder={t('backup.adoptPlaceholder')}
              placeholderTextColor={colors.ink3}
              autoCapitalize="characters"
              autoCorrect={false}
              keyboardAppearance={themeMode}
              accessibilityLabel={t('backup.adoptTitle')}
              style={[styles.input, { color: colors.ink, backgroundColor: colors.surfaceRaised, borderColor: colors.line }]}
            />
            {primary(t('backup.restoreConfirmAction'), () => void restore(), typedCode.trim().length === 0 || busy !== null, 'restore-run', busy === 'adopt')}
          </View>
        ),
      },
      {
        id: 'restoring',
        title: t('backup.restoringTitle'),
        status: statusOf('restoring'),
        children: (
          <View style={{ gap: 6 }} accessibilityLiveRegion="polite">
            <Spinner size="small" />
            <Text style={{ color: colors.ink, fontSize: 14 }}>{t('backup.restoredDescription', { count: restored })}</Text>
            <Text style={{ color: colors.ink2, fontSize: 13, lineHeight: 18 }}>{t('backup.restoringHint')}</Text>
          </View>
        ),
      },
    ];
  };

  if (state === 'loading') {
    return (
      <View style={{ paddingVertical: 24, alignItems: 'center' }}>
        <Spinner size="small" />
      </View>
    );
  }

  const switchOn = state !== 'off';
  const earnSource = gameAnimationFor('game-mark-earn');

  return (
    <View testID="backup-section" style={{ gap: 12 }}>
      <Group>
        <Row
          testID="backup-switch-row"
          title={t('backup.title')}
          trailing={
            busy === 'setup' || busy === 'off' ? (
              <Spinner size="small" />
            ) : (
              <Switch testID="backup-switch" value={switchOn} onToggle={onSwitch} size="md" />
            )
          }
        />
      </Group>
      <Help>{t('backup.offDescription')}</Help>

      {earned && motion && earnSource ? (
        // The one earned moment: backup turned on for the first time.
        <View pointerEvents="none" accessible={false} style={{ alignItems: 'center' }}>
          <LottieView
            source={earnSource as never}
            autoPlay
            loop={false}
            style={{ width: 64, height: 64 }}
            onAnimationFinish={() => setEarned(false)}
          />
        </View>
      ) : null}

      {state === 'on' ? statusCard() : null}
      {state !== 'off' ? <StepsAccordion testID="backup-steps" steps={backupSteps()} doneLabel={t('common.done')} /> : null}
      {state === 'on' ? (
        <Group>
          <Row
            testID="backup-run-now"
            title={busy === 'run' ? t('backup.working') : t('backup.runNow')}
            subtitle={t('backup.runNowHint')}
            trailing={busy === 'run' ? <Spinner size="small" /> : null}
            onPress={() => void backUpNow()}
          />
        </Group>
      ) : null}

      {/* Restore: its own card, always on screen and always last. */}
      <View testID="restore-card" style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line, marginTop: 8 }]}>
        <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: 16, fontWeight: '600' }}>
          {t('backup.restore')}
        </Text>
        {rstep === 'idle' ? (
          <>
            <Text style={{ color: colors.ink2, fontSize: 13, lineHeight: 18 }}>{t('backup.restoreBody')}</Text>
            <Pressable
              testID="restore-start"
              onPress={() => setRstep('where')}
              accessibilityRole="button"
              accessibilityLabel={t('backup.startRestoring')}
              style={[styles.secondary, { borderColor: colors.trackBorder }]}
            >
              <Text style={{ color: colors.ink, fontSize: 15, fontWeight: '600' }}>{t('backup.startRestoring')}</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={{ color: colors.ink2, fontSize: 13, lineHeight: 18 }}>{t('backup.restoreReplaces')}</Text>
            <StepsAccordion testID="restore-steps" steps={restoreSteps()} doneLabel={t('common.done')} />
            {rstep !== 'restoring' ? (
              <Pressable
                testID="restore-cancel"
                onPress={() => {
                  setRstep('idle');
                  setFound(null);
                  setTypedCode('');
                  // Re-derive the real backup state; never assume off.
                  refresh();
                }}
                accessibilityRole="button"
                style={styles.link}
              >
                <Text style={{ color: colors.ink2, fontSize: 15 }}>{t('common.cancel')}</Text>
              </Pressable>
            ) : null}
          </>
        )}
      </View>

      <BottomSheet testID="backup-code-sheet" open={showCode} onClose={() => setShowCode(false)}>
        <View style={{ gap: 12 }}>
          <Text style={{ color: colors.ink, fontSize: 17, fontWeight: '600' }}>{t('backup.codeTitle')}</Text>
          <Text style={{ color: colors.ink2, fontSize: 14, lineHeight: 20 }}>{t('backup.codeDescription')}</Text>
          {codeBox()}
          <Pressable onPress={shareCode} accessibilityRole="button" style={styles.link}>
            <MaterialIcons name="ios-share" size={18} color={colors.accentText} />
            <Text style={{ color: colors.accentText, fontSize: 15, fontWeight: '600' }}>{t('backup.shareCode')}</Text>
          </Pressable>
        </View>
      </BottomSheet>
    </View>
  );
};

const styles = StyleSheet.create({
  card: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 8 },
  choice: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: 12, padding: 12, minHeight: 56 },
  primary: { height: 48, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  secondary: { height: 44, borderRadius: 999, borderWidth: 1, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  link: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, alignSelf: 'flex-start' },
  check: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
  codeBox: { borderRadius: 12, borderWidth: 1, padding: 14 },
  input: { minHeight: 48, borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, fontFamily: 'monospace', fontSize: 15 },
});

export default BackupSection;
