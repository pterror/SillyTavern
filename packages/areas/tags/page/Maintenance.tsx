import { useUi } from '@st/page/context';

export type MaintenanceView =
    | { kind: 'prune'; count: number }
    | { kind: 'restore' }
    | { kind: 'restoreReport'; lines: string[] };

/** Content for the shared popup shell; the legacy controller owns the operation and its result. */
export function Maintenance(props: { view: MaintenanceView }) {
    const { t } = useUi();
    switch (props.view.kind) {
        case 'prune':
            return (
                <>
                    <h3>{t('Prune ${0} tags').replaceAll('${0}', String(props.view.count))}</h3>
                    <p>{t('Are you sure you want to remove all unused tags?')}</p>
                </>
            );
        case 'restore':
            return (
                <>
                    <h3>{t('Tag Restore')}</h3>
                    <p>
                        {t(
                            'You have existing tags. If the backup contains any of those tags, do you want the backup to overwrite their settings (Name, folder state, etc)?',
                        )}
                    </p>
                </>
            );
        case 'restoreReport':
            return (
                <>
                    <h3>{t('Tag Restore Warnings')}</h3>
                    <samp class="justifyLeft tag_restore_report">{props.view.lines.join('\n')}</samp>
                </>
            );
    }
}
