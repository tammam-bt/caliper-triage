import { StyleSheet, Text, View } from 'react-native';
import type { InferenceResult } from '@caliper/core';
import { getCondition } from '@caliper/core';
import { acuityColour, colour, font, space } from '../theme';

const BAND_TEXT: Record<string, string> = {
  urgent: 'Urgent — same-day review',
  prompt: 'Prompt — review within two weeks',
  routine: 'Routine',
  indeterminate: 'Indeterminate',
};

export function Readout({ result }: { result: InferenceResult }) {
  const top = result.candidates[0]!;
  const shown = result.candidates.filter((c) => c.probability >= 0.01).slice(0, 5);

  return (
    <View style={styles.wrap}>
      <View style={[styles.acuity, { borderLeftColor: acuityColour(result.acuity) }]}>
        <Text style={[styles.band, { color: acuityColour(result.acuity) }]}>
          {BAND_TEXT[result.acuity] ?? result.acuity}
        </Text>
        <Text style={styles.guidance}>
          {getCondition(result.abstained ? 'insufficient_evidence' : top.conditionId).guidance}
        </Text>
      </View>

      {result.abstained ? (
        <View style={styles.notice}>
          <Text style={styles.noticeTitle}>Withheld.</Text>
          <Text style={styles.noticeBody}>{result.abstainReason}</Text>
        </View>
      ) : (
        <View style={styles.headline}>
          <Text style={styles.headlineName}>{top.displayName}</Text>
          <View>
            <Text style={styles.headlineValue}>{(result.confidence * 100).toFixed(0)}%</Text>
            <Text style={font.label}>confidence</Text>
          </View>
        </View>
      )}

      <Text style={[font.label, { marginTop: space.md }]}>Differential</Text>
      {shown.map((candidate) => (
        <View key={candidate.conditionId} style={styles.row}>
          <View style={styles.rowTop}>
            <Text style={styles.rowName}>{candidate.displayName}</Text>
            <Text style={styles.rowValue}>{(candidate.probability * 100).toFixed(1)}%</Text>
          </View>
          <View style={styles.track}>
            <View
              style={[
                styles.fill,
                {
                  width: `${Math.max(1, candidate.probability * 100)}%`,
                  backgroundColor: acuityColour(candidate.acuity),
                },
              ]}
            />
          </View>
        </View>
      ))}

      <Text style={[font.label, { marginTop: space.md }]}>Why</Text>
      {top.evidence.slice(0, 5).map((item, i) => (
        <View key={`${item.label}-${i}`} style={styles.evidence}>
          <Text style={styles.evidenceLabel}>{item.label}</Text>
          <Text
            style={[
              styles.evidenceValue,
              { color: item.contribution >= 0 ? colour.urgent : colour.routine },
            ]}
          >
            {item.contribution >= 0 ? '+' : ''}
            {item.contribution.toFixed(2)}
          </Text>
        </View>
      ))}

      <Text style={styles.provenance}>
        {result.provider} · {result.modelId} · {result.computeMs} ms
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  acuity: {
    borderLeftWidth: 4,
    paddingLeft: space.md,
    paddingVertical: space.sm,
    backgroundColor: colour.paperSunk,
    gap: space.xs,
  },
  band: { fontSize: 12, fontWeight: '700', letterSpacing: 1.4, textTransform: 'uppercase' },
  guidance: { ...font.report, color: colour.ink },
  notice: {
    borderLeftWidth: 3,
    borderLeftColor: colour.prompt,
    borderWidth: 1,
    borderColor: colour.rule,
    padding: space.md,
    backgroundColor: colour.paperSunk,
  },
  noticeTitle: { fontWeight: '700', color: colour.ink },
  noticeBody: { ...font.report, color: colour.ink70 },
  headline: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: colour.ruleSoft,
    paddingBottom: space.sm,
  },
  headlineName: { fontSize: 22, color: colour.ink, flexShrink: 1, paddingRight: space.md },
  headlineValue: { ...font.data, fontSize: 30, color: colour.ink, textAlign: 'right' },
  row: { gap: 3, paddingVertical: space.xs },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between' },
  rowName: { ...font.report, color: colour.ink },
  rowValue: { ...font.data, color: colour.ink70 },
  track: { height: 3, backgroundColor: colour.ruleSoft },
  fill: { height: 3 },
  evidence: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 2,
    paddingHorizontal: space.sm,
    backgroundColor: colour.paperSunk,
  },
  evidenceLabel: { ...font.ui, color: colour.ink70 },
  evidenceValue: { ...font.data },
  provenance: { ...font.data, color: colour.ink45, marginTop: space.sm },
});
