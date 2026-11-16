import React, { FC, useMemo, useState } from 'react';
import { k8sPatch, useAccessReview, useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import { useTranslation } from 'react-i18next';
import { Alert, Button, ClipboardCopy, Flex, FlexItem } from '@patternfly/react-core';
import {
  HyperConvergedKind,
  HyperConvergedModel,
  StorageClassKind,
  StorageProfileModel,
  isMissingCrdError,
} from '../utils/k8s-resources';
import {
  MIN_PVC_SIZE_ANNOTATION,
  StorageProfileKind,
  XFS_MIN_PVC_SIZE,
  evaluateVmStateStorage,
  minPvcSizeCommand,
  vmStateStorageCommand,
} from '../utils/vm-state-storage';

const HCO_GVK = { group: HyperConvergedModel.apiGroup, version: HyperConvergedModel.apiVersion, kind: HyperConvergedModel.kind };
const SP_GVK = { group: StorageProfileModel.apiGroup, version: StorageProfileModel.apiVersion, kind: StorageProfileModel.kind };

type Props = {
  storageClasses: StorageClassKind[];
  storageClassesLoaded: boolean;
};

/**
 * Pre-flight: Windows VMs with a persistent TPM/EFI (Windows 11, Server 2025) get a tiny
 * Filesystem state PVC on the class KubeVirt resolves for VM state. On XFS it can't be
 * formatted and the VM never starts. Warn, and offer the fixes.
 */
const VmStateStorageCheck: FC<Props> = ({ storageClasses, storageClassesLoaded }) => {
  const { t } = useTranslation('plugin__oct-windows-builder');
  const [hcos, hcoLoaded, hcoErr] = useK8sWatchResource<HyperConvergedKind[]>({ groupVersionKind: HCO_GVK, isList: true, namespaced: false });
  const [profiles, spLoaded] = useK8sWatchResource<StorageProfileKind[]>({ groupVersionKind: SP_GVK, isList: true, namespaced: false });
  const [busy, setBusy] = useState('');
  const [applyError, setApplyError] = useState('');
  const [applied, setApplied] = useState('');

  const hco = (hcos || [])[0];
  const ns = hco?.metadata?.namespace || 'openshift-cnv';
  const result = useMemo(
    () => evaluateVmStateStorage(hco?.spec?.vmStateStorageClass, storageClasses, profiles || []),
    [hco, storageClasses, profiles],
  );
  const [canPatchHco] = useAccessReview({
    group: HyperConvergedModel.apiGroup,
    resource: HyperConvergedModel.plural,
    verb: 'patch',
    namespace: ns,
    name: hco?.metadata?.name,
  });
  const [canPatchProfile] = useAccessReview({
    group: StorageProfileModel.apiGroup,
    resource: StorageProfileModel.plural,
    verb: 'patch',
    name: result.className || undefined,
  });

  const recovery = t(
    'A VM that is already stuck: stop it, delete its persistent-state-for-<vm>-xxxxx PVC and start it again. Only do this for a VM that never booted: the state volume holds the VM\'s TPM (BitLocker keys) and EFI variables, and deleting it on a used VM loses them.',
  );

  if (applied) {
    return (
      <Alert variant="success" isInline title={applied}>
        {recovery}
      </Alert>
    );
  }
  if (!storageClassesLoaded || !spLoaded) return null;
  // Check the error before the loaded flag: a 403 reports loaded=false together with the error.
  // Can't read the HyperConverged resource: judge from the default classes the user can see,
  // with a softer note (an admin may have set another VM state class) and no buttons.
  if (hcoErr) {
    if (isMissingCrdError(hcoErr)) return null; // no OpenShift Virtualization: nothing to check
    const guess = evaluateVmStateStorage(undefined, storageClasses, profiles || []);
    if (!guess.broken) return null;
    return (
      <Alert variant="info" isInline title={t('Windows 11 VMs may not start: the default VM state class {{sc}} uses XFS', { sc: guess.className })}>
        {t('Unless a cluster admin set another VM state class in OpenShift Virtualization, VMs with a persistent TPM or EFI (Windows 11) will stay in Scheduling. Ask a cluster admin to check the HyperConverged vmStateStorageClass setting.')}
      </Alert>
    );
  }
  if (!hcoLoaded || !hco?.metadata?.name || !result.broken) return null;

  const sc = result.className;
  const fix = result.suggestion;
  const run = async (what: 'hco' | 'profile') => {
    setBusy(what);
    setApplyError('');
    try {
      if (what === 'hco') {
        await k8sPatch({
          model: HyperConvergedModel,
          resource: hco,
          // v1beta1 field (see HyperConvergedKind).
          data: [{ op: 'add', path: '/spec/vmStateStorageClass', value: fix }],
        });
        setApplied(t('VM state now uses {{sc}}. New Windows VMs can start.', { sc: fix }));
      } else {
        const profile = (profiles || []).find((p) => p.metadata.name === sc);
        if (!profile) throw new Error(t('StorageProfile {{sc}} not found.', { sc }));
        const key = MIN_PVC_SIZE_ANNOTATION.replace('/', '~1');
        await k8sPatch({
          model: StorageProfileModel,
          resource: profile,
          data: profile.metadata.annotations
            ? [{ op: 'add', path: `/metadata/annotations/${key}`, value: XFS_MIN_PVC_SIZE }]
            : [{ op: 'add', path: '/metadata/annotations', value: { [MIN_PVC_SIZE_ANNOTATION]: XFS_MIN_PVC_SIZE } }],
        });
        setApplied(t('{{sc}} now creates volumes of at least {{size}}. New Windows VMs can start.', { sc, size: XFS_MIN_PVC_SIZE }));
      }
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const where =
    result.source === 'hyperconverged'
      ? t('the HyperConverged vmStateStorageClass setting')
      : result.source === 'default-virt'
        ? t('the default virtualization StorageClass')
        : t('the default StorageClass');

  return (
    <Alert variant="warning" isInline title={t('Windows 11 VMs will not start: VM state storage uses XFS ({{sc}})', { sc })}>
      <p>
        {t('OpenShift Virtualization stores each VM\'s TPM and EFI state on {{sc}} ({{where}}).', { sc, where })}{' '}
        {t('That volume is about 10 MiB and XFS cannot be formatted that small, so Windows 11 and other templates with a persistent TPM or EFI stay in Scheduling.')}
      </p>
      {result.tiedWith.length ? (
        <p>{t('Several StorageClasses are marked default ({{others}}); KubeVirt may use any of them.', { others: [sc, ...result.tiedWith].join(', ') })}</p>
      ) : null}
      <p>{t('Either fix works; both change cluster-wide settings:')}</p>
      <Flex direction={{ default: 'column' }} spaceItems={{ default: 'spaceItemsSm' }}>
        {fix ? (
          <FlexItem>
            <strong>{t('Store VM state on {{fix}}', { fix })}</strong>{' '}
            {t('(a class that formats small volumes)')}
            {canPatchHco ? (
              <>
                {' '}
                <Button variant="secondary" size="sm" onClick={() => run('hco')} isLoading={busy === 'hco'} isDisabled={Boolean(busy)}>
                  {t('Use {{fix}} for VM state', { fix })}
                </Button>
              </>
            ) : null}
            <ClipboardCopy isReadOnly hoverTip={t('Copy')} clickTip={t('Copied')}>
              {vmStateStorageCommand(ns, hco.metadata.name, fix)}
            </ClipboardCopy>
          </FlexItem>
        ) : null}
        <FlexItem>
          <strong>{t('Keep {{sc}} and give its volumes a minimum size of {{size}}', { sc, size: XFS_MIN_PVC_SIZE })}</strong>{' '}
          {t('(StorageProfile annotation; each VM state volume then uses {{size}})', { size: XFS_MIN_PVC_SIZE })}
          {canPatchProfile ? (
            <>
              {' '}
              <Button variant="secondary" size="sm" onClick={() => run('profile')} isLoading={busy === 'profile'} isDisabled={Boolean(busy)}>
                {t('Set the minimum size')}
              </Button>
            </>
          ) : null}
          <ClipboardCopy isReadOnly hoverTip={t('Copy')} clickTip={t('Copied')}>
            {minPvcSizeCommand(sc)}
          </ClipboardCopy>
        </FlexItem>
      </Flex>
      {!canPatchHco && !canPatchProfile ? <p>{t('Ask a cluster admin to run one of these commands.')}</p> : null}
      {applyError ? (
        <Alert variant="danger" isInline isPlain title={t('Could not apply the fix')}>
          {applyError}
        </Alert>
      ) : null}
    </Alert>
  );
};

export default VmStateStorageCheck;
