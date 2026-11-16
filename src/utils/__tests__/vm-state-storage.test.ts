import { describe, expect, it } from 'vitest';
import { StorageClassKind } from '../k8s-resources';
import {
  StorageProfileKind,
  evaluateVmStateStorage,
  ext4Variant,
  pvcRenderingEnabled,
  quantityBytes,
  storageClassYaml,
  vmStateStorageCommand,
} from '../vm-state-storage';

const DEF = { 'storageclass.kubernetes.io/is-default-class': 'true' };
const VIRT = { 'storageclass.kubevirt.io/is-default-virt-class': 'true' };
const sc = (name: string, provisioner: string, fs = '', annotations: Record<string, string> = {}): StorageClassKind => ({
  metadata: { name, annotations },
  provisioner,
  parameters: fs ? { 'csi.storage.k8s.io/fstype': fs } : {},
});
const fsProfile = (name: string, annotations?: Record<string, string>): StorageProfileKind => ({
  metadata: { name, annotations },
  status: { claimPropertySets: [{ accessModes: ['ReadWriteOnce'], volumeMode: 'Filesystem' }] },
});
const blockOnly = (name: string): StorageProfileKind => ({
  metadata: { name },
  status: { claimPropertySets: [{ accessModes: ['ReadWriteMany'], volumeMode: 'Block' }] },
});

describe('evaluateVmStateStorage', () => {
  it('flags the HyperConverged class when it is XFS and suggests an ext4 class', () => {
    const classes = [sc('pure-fs', 'pxd.portworx.com', 'xfs'), sc('rbd', 'openshift-storage.rbd.csi.ceph.com', 'ext4', DEF)];
    const r = evaluateVmStateStorage('pure-fs', classes, [fsProfile('pure-fs'), fsProfile('rbd')]);
    expect(r).toMatchObject({ className: 'pure-fs', source: 'hyperconverged', broken: true, suggestion: 'rbd' });
  });

  it('is quiet once the HyperConverged class is ext4', () => {
    const classes = [sc('pure-fs', 'pxd.portworx.com', 'xfs'), sc('rbd', 'openshift-storage.rbd.csi.ceph.com', 'ext4', DEF)];
    expect(evaluateVmStateStorage('rbd', classes, [fsProfile('rbd')]).broken).toBe(false);
  });

  it('uses the default virtualization class before the regular default (no false alarm)', () => {
    // LVMS (XFS) is the default, ODF ext4 is the default virt class: VMs start fine.
    const classes = [sc('lvms', 'topolvm.io', 'xfs', DEF), sc('odf-virt', 'openshift-storage.rbd.csi.ceph.com', 'ext4', VIRT)];
    expect(evaluateVmStateStorage('', classes, [fsProfile('lvms'), fsProfile('odf-virt')])).toMatchObject({
      className: 'odf-virt',
      source: 'default-virt',
      broken: false,
    });
  });

  it('catches an XFS default virtualization class even when the regular default is ext4', () => {
    const classes = [sc('rbd', 'openshift-storage.rbd.csi.ceph.com', 'ext4', DEF), sc('lvms', 'topolvm.io', 'xfs', VIRT)];
    expect(evaluateVmStateStorage('', classes, [fsProfile('rbd'), fsProfile('lvms')])).toMatchObject({
      className: 'lvms',
      source: 'default-virt',
      broken: true,
      suggestion: 'rbd',
    });
  });

  it('falls back to the regular default when there is no default virtualization class', () => {
    const classes = [sc('xfsdef', 'x.csi', 'xfs', DEF), sc('ext', 'y.csi', 'ext4')];
    expect(evaluateVmStateStorage('', classes, [fsProfile('xfsdef'), fsProfile('ext')])).toMatchObject({
      source: 'default',
      broken: true,
      suggestion: 'ext',
    });
  });

  it('reports a broken class among several tied defaults', () => {
    const classes = [sc('a', 'x.csi', 'ext4', DEF), sc('b', 'x.csi', 'xfs', DEF)];
    const r = evaluateVmStateStorage('', classes, [fsProfile('a'), fsProfile('b')]);
    expect(r).toMatchObject({ className: 'b', broken: true, tiedWith: ['a'] });
  });

  it('treats an XFS class with a minimumSupportedPvcSize of 300Mi or more as fine', () => {
    const classes = [sc('pure-fs', 'pxd.portworx.com', 'xfs', DEF)];
    const ok = evaluateVmStateStorage('', classes, [fsProfile('pure-fs', { 'cdi.kubevirt.io/minimumSupportedPvcSize': '1Gi' })]);
    const small = evaluateVmStateStorage('', classes, [fsProfile('pure-fs', { 'cdi.kubevirt.io/minimumSupportedPvcSize': '100Mi' })]);
    expect(ok.broken).toBe(false);
    expect(small.broken).toBe(true);
  });

  it('suggests CephFS or NFS when every RBD class is XFS', () => {
    const classes = [
      sc('rbd-xfs', 'openshift-storage.rbd.csi.ceph.com', 'xfs', DEF),
      sc('cephfs', 'openshift-storage.cephfs.csi.ceph.com'),
      sc('nfs', 'nfs.csi.k8s.io'),
    ];
    const profiles = [fsProfile('rbd-xfs'), fsProfile('cephfs'), fsProfile('nfs')];
    expect(evaluateVmStateStorage('', classes, profiles).suggestion).toBe('cephfs');
    expect(evaluateVmStateStorage('', classes.filter((c) => c.metadata.name !== 'cephfs'), profiles).suggestion).toBe('nfs');
  });

  it('never suggests a class whose StorageProfile cannot bind a Filesystem volume', () => {
    const classes = [sc('xfs', 'x.csi', 'xfs', DEF), sc('blockonly', 'y.csi', 'ext4'), sc('noprofile', 'z.csi', 'ext4')];
    expect(evaluateVmStateStorage('', classes, [fsProfile('xfs'), blockOnly('blockonly')]).suggestion).toBe('');
  });

  it('never suggests object-bucket or static local classes', () => {
    const classes = [
      sc('xfs', 'x.csi', 'xfs', DEF),
      sc('bkt', 'openshift-storage.noobaa.io/obc'),
      sc('local', 'kubernetes.io/no-provisioner'),
    ];
    expect(evaluateVmStateStorage('', classes, [fsProfile('xfs'), fsProfile('bkt'), fsProfile('local')]).suggestion).toBe('');
  });

  it('says nothing when no class is set and none is default', () => {
    expect(evaluateVmStateStorage('', [sc('a', 'x.csi', 'xfs')], [fsProfile('a')])).toMatchObject({ source: 'none', broken: false });
  });
});

describe('quantityBytes', () => {
  it('parses binary and decimal suffixes', () => {
    expect(quantityBytes('300Mi')).toBe(300 * 1024 * 1024);
    expect(quantityBytes('1Gi')).toBe(1024 ** 3);
    expect(quantityBytes('500M')).toBe(500e6);
    expect(quantityBytes('junk')).toBe(0);
  });
});

describe('vmStateStorageCommand', () => {
  it('patches the v1beta1 field the plugin reads', () => {
    const cmd = vmStateStorageCommand('openshift-cnv', 'kubevirt-hyperconverged', 'rbd');
    expect(cmd).toContain('hyperconverged.v1beta1.hco.kubevirt.io');
    expect(cmd).toContain('{"spec":{"vmStateStorageClass":"rbd"}}');
  });
});

describe('block-only clusters', () => {
  const pureXfs = sc('pure-fs', 'pxd.portworx.com', 'xfs', DEF);
  const annotated = fsProfile('pure-fs', { 'cdi.kubevirt.io/minimumSupportedPvcSize': '300Mi' });

  it('reads the PVC rendering gate from CDI', () => {
    expect(pvcRenderingEnabled(['HonorWaitForFirstConsumer', 'WebhookPvcRendering'])).toBe(true);
    expect(pvcRenderingEnabled(['HonorWaitForFirstConsumer'])).toBe(false);
    expect(pvcRenderingEnabled(undefined)).toBeUndefined();
  });

  it('counts the minimum-size annotation only while the gate is on (or CDI is unreadable)', () => {
    expect(evaluateVmStateStorage('', [pureXfs], [annotated], true).broken).toBe(false);
    expect(evaluateVmStateStorage('', [pureXfs], [annotated], undefined).broken).toBe(false);
    const off = evaluateVmStateStorage('', [pureXfs], [annotated], false);
    expect(off).toMatchObject({ broken: true, annotationIneffective: true });
  });

  it('flags a class that declares no filesystem as undeclared, not broken', () => {
    const r = evaluateVmStateStorage('', [sc('pure', 'pxd.portworx.com', '', DEF)], [fsProfile('pure')]);
    expect(r).toMatchObject({ className: 'pure', broken: false, undeclared: true });
  });

  it('does not call known driver defaults undeclared (Ceph RBD, CephFS, NFS)', () => {
    for (const prov of ['openshift-storage.rbd.csi.ceph.com', 'openshift-storage.cephfs.csi.ceph.com', 'nfs.csi.k8s.io']) {
      const r = evaluateVmStateStorage('', [sc('c', prov, '', DEF)], [fsProfile('c')]);
      expect(r.undeclared).toBe(false);
    }
  });

  it('builds an ext4 variant: same driver and settings, ext4, no XFS mount options, not default', () => {
    const src: Parameters<typeof ext4Variant>[0] = {
      metadata: { name: 'pure-filesystem', annotations: DEF },
      provisioner: 'pxd.portworx.com',
      parameters: { 'csi.storage.k8s.io/fstype': 'xfs', backend: 'pure_block' },
      reclaimPolicy: 'Delete',
      volumeBindingMode: 'WaitForFirstConsumer',
      allowVolumeExpansion: true,
      mountOptions: ['nouuid', 'discard'],
    };
    const v = ext4Variant(src);
    expect(v.metadata.name).toBe('pure-ext4');
    expect(v.metadata.annotations?.['storageclass.kubernetes.io/is-default-class']).toBeUndefined();
    expect(v.parameters).toEqual({ 'csi.storage.k8s.io/fstype': 'ext4', backend: 'pure_block' });
    expect(v.mountOptions).toEqual(['discard']);
    expect(v).toMatchObject({ provisioner: 'pxd.portworx.com', reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer', allowVolumeExpansion: true });
    const yaml = storageClassYaml(v);
    expect(yaml).toContain('name: pure-ext4');
    expect(yaml).toContain('csi.storage.k8s.io/fstype: "ext4"');
    expect(yaml).not.toContain('nouuid');
  });
});
