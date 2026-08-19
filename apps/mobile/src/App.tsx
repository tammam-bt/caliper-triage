/**
 * Caliper, on a phone.
 *
 * The point of this app in the repository is that it shares the domain: `@caliper/core` and
 * `@caliper/service` are imported unchanged, so the condition catalogue, the computer vision, the
 * symptom lexicon, the fusion weights and the abstention rule are the *same code* the web console
 * and the Express API run. There is one taxonomy and one calibration in this system, not three
 * that drift.
 *
 * What is genuinely platform-specific is small and lives at the edges: image picking, decoding, and
 * the notification hook.
 */
import { useCallback, useState } from 'react';
import {
  ActivityIndicator, Image, Platform, Pressable, SafeAreaView, ScrollView, StatusBar,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import type { Analysis, MediaUpload, Stage } from '@caliper/core';
import { IntakeSchema, STAGES } from '@caliper/core';
import { createPipeline } from './pipeline';
import { decodeAsset, type DecodedAsset } from './decode';
import { Readout } from './components/Readout';
import { colour, font, space } from './theme';
import { notifyComplete, requestNotificationPermission } from './notifications';

const CHIPS = ['changing', 'growing', 'bleeding', 'itching', 'painful', 'non-healing', 'spreading', 'fever'];

const pipeline = createPipeline();

export default function App() {
  const [asset, setAsset] = useState<DecodedAsset | null>(null);
  const [symptomsText, setSymptomsText] = useState('');
  const [symptomIds, setSymptomIds] = useState<string[]>([]);
  const [evolving, setEvolving] = useState(false);
  const [stage, setStage] = useState<Stage | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = useCallback(async (from: 'camera' | 'library') => {
    setError(null);
    const permission =
      from === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError(
        from === 'camera'
          ? 'Camera access is needed to photograph the area. Enable it in Settings.'
          : 'Photo access is needed to attach an image. Enable it in Settings.',
      );
      return;
    }

    const result =
      from === 'camera'
        ? await ImagePicker.launchCameraAsync({ quality: 0.9 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.9 });
    if (result.canceled || !result.assets[0]) return;

    setBusy(true);
    try {
      setAsset(await decodeAsset(result.assets[0].uri));
      setAnalysis(null);
      setStage(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That image could not be read.');
    } finally {
      setBusy(false);
    }
  }, []);

  const run = useCallback(async () => {
    if (!asset) return;
    setBusy(true);
    setError(null);
    setAnalysis(null);
    void requestNotificationPermission();

    const media: MediaUpload = {
      kind: 'image',
      mimeType: 'image/png',
      byteSize: asset.frame.data.byteLength,
      width: asset.frame.width,
      height: asset.frame.height,
    };

    try {
      const intake = IntakeSchema.parse({
        symptomsText,
        symptomIds,
        ...(evolving ? { evolving: true } : {}),
      });
      const result = await pipeline.run(intake, media, [asset.frame], (event) => setStage(event.stage));
      setAnalysis(result);
      if (result.result) await notifyComplete(result.result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The assessment failed.');
    } finally {
      setBusy(false);
    }
  }, [asset, symptomsText, symptomIds, evolving]);

  const toggleChip = (chip: string) =>
    setSymptomIds((prev) => (prev.includes(chip) ? prev.filter((c) => c !== chip) : [...prev, chip]));

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={colour.drape} />
      <View style={styles.topbar}>
        <Text style={styles.brand}>Caliper</Text>
        <Text style={styles.tagline}>assistive triage</Text>
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <View style={styles.viewport}>
          {asset ? (
            <Image source={{ uri: asset.uri }} style={styles.image} resizeMode="contain" />
          ) : (
            <View style={styles.empty}>
              <View style={styles.graticule} />
              <Text style={styles.emptyText}>
                Photograph the area, including a margin of normal skin around it.
              </Text>
            </View>
          )}
          {asset && analysis?.result?.features && (
            <Text style={styles.meta}>
              {`A ${analysis.result.features.asymmetry.toFixed(3)}  `}
              {`B ${analysis.result.features.borderIrregularity.toFixed(2)}  `}
              {`C ${analysis.result.features.colourHeterogeneity.toFixed(2)}`}
            </Text>
          )}
        </View>

        <View style={styles.actionRow}>
          <Pressable style={styles.button} onPress={() => pick('camera')} disabled={busy}>
            <Text style={styles.buttonText}>Camera</Text>
          </Pressable>
          <Pressable style={[styles.button, styles.buttonQuiet]} onPress={() => pick('library')} disabled={busy}>
            <Text style={[styles.buttonText, styles.buttonQuietText]}>Choose photo</Text>
          </Pressable>
        </View>

        <Text style={font.label}>Symptoms</Text>
        <TextInput
          style={styles.input}
          multiline
          value={symptomsText}
          onChangeText={setSymptomsText}
          placeholder="What does the patient report? Negations are understood."
          placeholderTextColor={colour.ink45}
        />

        <Text style={font.label}>Reported findings</Text>
        <View style={styles.chips}>
          {CHIPS.map((chip) => {
            const on = symptomIds.includes(chip);
            return (
              <Pressable
                key={chip}
                onPress={() => toggleChip(chip)}
                style={[styles.chip, on && styles.chipOn]}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
              >
                <Text style={[styles.chipText, on && styles.chipTextOn]}>{chip}</Text>
              </Pressable>
            );
          })}
        </View>

        <Pressable style={styles.check} onPress={() => setEvolving((v) => !v)}>
          <View style={[styles.checkbox, evolving && styles.checkboxOn]} />
          <Text style={styles.checkLabel}>It has changed recently.</Text>
        </Pressable>

        <Pressable
          style={[styles.button, styles.runButton, (!asset || busy) && styles.buttonDisabled]}
          onPress={run}
          disabled={!asset || busy}
        >
          {busy ? <ActivityIndicator color={colour.drapeInk} /> : <Text style={styles.buttonText}>Run assessment</Text>}
        </Pressable>

        {stage && !analysis && (
          <Text style={styles.stageLine}>
            {STAGES.map((s) => (s === stage ? `[${s}]` : s)).join('  ›  ')}
          </Text>
        )}

        {error && (
          <View style={styles.error}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {analysis?.result && <Readout result={analysis.result} />}

        <Text style={styles.disclaimer}>
          Not a medical device. Caliper is an engineering prototype. It is not clinically validated,
          has not been trained on a labelled dataset, and must not be used to make a care decision.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colour.bone },
  topbar: {
    backgroundColor: colour.drape,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.sm,
  },
  brand: { color: colour.drapeInk, fontSize: 20, fontWeight: '600' },
  tagline: { color: '#FFFFFFA8', fontSize: 11, letterSpacing: 1.4, textTransform: 'uppercase' },
  body: { padding: space.lg, gap: space.md, paddingBottom: space.xl * 2 },
  viewport: { backgroundColor: colour.ink, minHeight: 240, justifyContent: 'center', overflow: 'hidden' },
  image: { width: '100%', height: 280 },
  empty: { alignItems: 'center', gap: space.md, padding: space.xl },
  graticule: { width: 120, height: 120, borderWidth: 1, borderColor: '#FFFFFF26' },
  emptyText: { color: '#B9C6C3', textAlign: 'center', ...font.report },
  meta: {
    ...font.data,
    color: '#CFE6E4',
    position: 'absolute',
    top: space.sm,
    left: space.md,
  },
  actionRow: { flexDirection: 'row', gap: space.sm },
  button: {
    flex: 1,
    backgroundColor: colour.drape,
    paddingVertical: space.md,
    alignItems: 'center',
    borderRadius: 3,
  },
  runButton: { flex: 0 },
  buttonQuiet: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colour.rule },
  buttonDisabled: { backgroundColor: colour.ruleSoft },
  buttonText: { color: colour.drapeInk, fontWeight: '600', letterSpacing: 1.1, textTransform: 'uppercase', fontSize: 12 },
  buttonQuietText: { color: colour.ink70 },
  input: {
    borderWidth: 1,
    borderColor: colour.rule,
    backgroundColor: colour.paperSunk,
    padding: space.md,
    minHeight: 84,
    textAlignVertical: 'top',
    ...font.report,
    color: colour.ink,
    borderRadius: 3,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  chip: { borderWidth: 1, borderColor: colour.rule, borderRadius: 999, paddingHorizontal: space.md, paddingVertical: 5 },
  chipOn: { backgroundColor: colour.drape, borderColor: colour.drape },
  chipText: { fontSize: 13, color: colour.ink70 },
  chipTextOn: { color: colour.drapeInk },
  check: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  checkbox: { width: 18, height: 18, borderWidth: 1, borderColor: colour.rule, backgroundColor: colour.paper },
  checkboxOn: { backgroundColor: colour.drape, borderColor: colour.drape },
  checkLabel: { ...font.report, color: colour.ink, flexShrink: 1 },
  stageLine: { ...font.data, color: colour.drapeLift },
  error: { borderLeftWidth: 3, borderLeftColor: colour.urgent, backgroundColor: colour.paperSunk, padding: space.md },
  errorText: { ...font.report, color: colour.ink },
  disclaimer: {
    ...font.ui,
    fontSize: 11,
    color: colour.ink45,
    borderTopWidth: 1,
    borderTopColor: colour.rule,
    paddingTop: space.md,
    marginTop: space.lg,
    lineHeight: 16,
  },
});

// Silences an unused-import warning on web, where Platform is not otherwise referenced.
export const platform = Platform.OS;
