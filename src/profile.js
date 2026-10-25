// Assembly sessions (live captions, absolute time) and general sessions (uploaded meetings and
// lectures, elapsed time). Records without a profile predate profiles and are Assembly.
export const profileOf = (meeting) => (meeting?.profile === 'general' ? 'general' : 'assembly');
export const isElapsed = (meeting) => meeting?.timeBasis === 'elapsed';

/** Elapsed time from the media origin as HH:MM; hours keep counting past 24. */
export function formatElapsed(ms) {
  const minutes = Math.floor(ms / 60_000);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

// Read adapter: Assembly output keeps its legacy members/institutions fields on disk, general
// output stores neutral speakers/organizations. Readers use these and never rewrite old files.
export const speakersOf = (x) => x?.speakers ?? x?.members ?? [];
export const organizationsOf = (x) => x?.organizations ?? x?.institutions ?? [];
export const speakerLabel = (name, profile) => (profile === 'assembly' ? `${name} 위원` : name);

/** Topic with neutral speaker/organization fields on entries and summary bullets. */
export function neutralTopic(topic) {
  return {
    ...topic,
    entries: topic.entries.map((e) => ({
      ...e,
      speakers: speakersOf(e),
      organizations: organizationsOf(e),
    })),
    summary: topic.summary?.bullets
      ? {
          ...topic.summary,
          bullets: topic.summary.bullets.map((b) => ({
            ...b,
            speaker: b.speaker ?? b.member ?? '',
            organization: b.organization ?? b.institution ?? '',
          })),
        }
      : topic.summary,
  };
}
