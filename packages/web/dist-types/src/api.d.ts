import type { StudyBoxSettings, StudyBoxSnapshot } from "@studybox/shared";
export declare function getSnapshot(): Promise<StudyBoxSnapshot>;
export declare function postAction(path: string): Promise<StudyBoxSnapshot>;
export declare function saveSettings(settings: StudyBoxSettings): Promise<StudyBoxSettings>;
