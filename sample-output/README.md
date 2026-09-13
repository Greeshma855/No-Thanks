# Sample Output

These four self-contained runs demonstrate the same safety and verification pipeline in visible Inspector mode and unattended Guardian mode. Each folder contains a human-readable report, structured audit log, chronological DOM screenshots, and one finalized WebM recording.

All samples use deterministic Strands mock reasoning against the real rendered websites. This isolates browser perception, consent targeting, safety validation, action execution, and verification from paid-model availability.

| Sample                                                       | Mode      | What it proves                                                                                                                             | Result                                            |
| ------------------------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| [Al Jazeera — headed](al-jazeera-headed/report.html)         | Inspector | Visual reasoning overlay, registered bounding boxes, preference-center discovery, four optional categories disabled, and choices confirmed | `LIKELY_VERIFIED` · banner gone · no safety stops |
| [The Guardian — headed](the-guardian-headed/report.html)     | Inspector | A visible “No, thank you” control is registered and preferred over acceptance                                                              | `LIKELY_VERIFIED` · banner gone · no safety stops |
| [Al Jazeera — headless](al-jazeera-headless/report.html)     | Guardian  | The same multi-layer preference workflow runs without overlays or presentation delays                                                      | `LIKELY_VERIFIED` · banner gone · no safety stops |
| [The Guardian — headless](the-guardian-headless/report.html) | Guardian  | Fast background rejection through a registered explicit control                                                                            | `LIKELY_VERIFIED` · banner gone · no safety stops |

## Run assets

### Al Jazeera — headed

- [Audit report](al-jazeera-headed/report.html)
- [Structured log](al-jazeera-headed/audit.json)
- [Recording](al-jazeera-headed/recording.webm)
- [Initial screenshot](al-jazeera-headed/raw/screenshots/00-initial.png)
- [Final screenshot](al-jazeera-headed/raw/screenshots/04-final.png)

### The Guardian — headed

- [Audit report](the-guardian-headed/report.html)
- [Structured log](the-guardian-headed/audit.json)
- [Recording](the-guardian-headed/recording.webm)
- [Initial screenshot](the-guardian-headed/raw/screenshots/00-initial.png)
- [Final screenshot](the-guardian-headed/raw/screenshots/03-final.png)

### Al Jazeera — headless

- [Audit report](al-jazeera-headless/report.html)
- [Structured log](al-jazeera-headless/audit.json)
- [Recording](al-jazeera-headless/recording.webm)
- [Initial screenshot](al-jazeera-headless/raw/screenshots/00-initial.png)
- [Final screenshot](al-jazeera-headless/raw/screenshots/04-final.png)

### The Guardian — headless

- [Audit report](the-guardian-headless/report.html)
- [Structured log](the-guardian-headless/audit.json)
- [Recording](the-guardian-headless/recording.webm)
- [Initial screenshot](the-guardian-headless/raw/screenshots/00-initial.png)
- [Final screenshot](the-guardian-headless/raw/screenshots/03-final.png)

## Interpreting the evidence

`LIKELY_VERIFIED` means a privacy-reducing action succeeded and a fresh final perception confirmed that the consent interface disappeared, but generic storage or post-refresh persistence was not proven. The reports do not upgrade this evidence to `VERIFIED` without that additional proof.

The headed recordings include presentation overlays and may intentionally pause for readability. Headless recordings contain no artificial demo pacing. Their total duration still includes live DNS, navigation, third-party frame loading, bounded discovery, screenshots, and final verification, so end-to-end timing varies with the website and network.
