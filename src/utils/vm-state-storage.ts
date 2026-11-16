/**
 * Pre-flight check for the storage class KubeVirt uses for VM state.
 *
 * Windows 11 (and other Windows templates with a persistent TPM or EFI) get a tiny
 * "persistent-state-for-<vm>" PVC, about 10 MiB, always in Filesystem mode. KubeVirt
 * picks its class like this (KubeVirt 1.8, OpenShift Virtualization 4.22):
 *   1. HyperConverged vmStateStorageClass (v1beta1 spec.vmStateStorageClass, v1
 *      spec.storage.vmStateStorageClass; KubeVirt configuration.vmStateStorageClass),
 *   2. else the default virtualization class (storageclass.kubevirt.io/is-default-virt-class),
 *   3. else the default class (storageclass.kubernetes.io/is-default-class).
 * XFS cannot be formatted that small (minimum 300 MB), so on an XFS class the VM never
 * starts: the launcher pod stays in Init with "data subvolume is too small".
 *
 * Fixes: point VM state at a class that formats small volumes (ext4, CephFS, NFS), or keep
 * the XFS class and annotate its StorageProfile with cdi.kubevirt.io/minimumSupportedPvcSize
 * so CDI rounds the request up to a size XFS can format.
 *
 * Pure module (no console SDK) so the decision is unit-tested.
 */
import { StorageClassKind } from './k8s-resources';

export const DEFAULT_CLASS_ANNOTATION = 'storageclass.kubernetes.io/is-default-class';
export const DEFAULT_VIRT_CLASS_ANNOTATION = 'storageclass.kubevirt.io/is-default-virt-class';
export const MIN_PVC_SIZE_ANNOTATION = 'cdi.kubevirt.io/minimumSupportedPvcSize';
export const XFS_MIN_PVC_SIZE = '300Mi';

export type StorageProfileKind = {
  metadata: { name: string; annotations?: Record<string, string> };
  status?: { claimPropertySets?: Array<{ accessModes?: string[]; volumeMode?: string }> };
};

export type VmStateStorage = {
  /** Effective class ('' when nothing is set and no default exists). */
  className: string;
  source: 'hyperconverged' | 'default-virt' | 'default' | 'none';
  /** Other classes tied as default at the same level (KubeVirt may pick any of them). */
  tiedWith: string[];
  fsType: string;
  /** VM state volumes can't be created: an XFS class without an effective minimum PVC size. */
  broken: boolean;
  /** The class declares no filesystem and its driver's default is unknown (it may be XFS). */
  undeclared: boolean;
  /** The minimum-size annotation is set but CDI's PVC rendering gate is off, so it has no effect. */
  annotationIneffective: boolean;
  /** A class that can hold tiny Filesystem volumes ('' when none). */
  suggestion: string;
};

const FSTYPE_KEYS = ['csi.storage.k8s.io/fstype', 'fsType', 'fstype', 'fs'];

export function storageClassFsType(sc?: StorageClassKind): string {
  const p = sc?.parameters || {};
  for (const k of FSTYPE_KEYS) {
    if (p[k]) return String(p[k]).toLowerCase();
  }
  return '';
}

const isTrue = (sc: StorageClassKind, ann: string) => sc.metadata.annotations?.[ann] === 'true';

/** Parses Kubernetes quantities like 300Mi, 1Gi, 500M into bytes (0 when unknown). */
export function quantityBytes(q?: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([KMGTPE]i?)?$/.exec((q || '').trim());
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2] || '';
  const pow: Record<string, number> = { K: 1, M: 2, G: 3, T: 4, P: 5, E: 6 };
  if (!unit) return n;
  const base = unit.endsWith('i') ? 1024 : 1000;
  return n * Math.pow(base, pow[unit[0]]);
}

/** XFS is fine when the class's StorageProfile makes CDI request at least 300Mi. */
/** CDI applies cdi.kubevirt.io/minimumSupportedPvcSize through its PVC rendering webhook. */
export const PVC_RENDERING_GATE = 'WebhookPvcRendering';

/**
 * Whether the minimum-size annotation takes effect: true/false from CDI's feature gates,
 * undefined when CDI can't be read (then assume it does, as on OpenShift Virtualization's default).
 */
export function pvcRenderingEnabled(cdiFeatureGates?: string[] | null): boolean | undefined {
  if (!cdiFeatureGates) return undefined;
  return cdiFeatureGates.includes(PVC_RENDERING_GATE);
}

function xfsSafe(profile: StorageProfileKind | undefined, rendering: boolean | undefined): boolean {
  if (rendering === false) return false;
  return quantityBytes(profile?.metadata.annotations?.[MIN_PVC_SIZE_ANNOTATION]) >= quantityBytes(XFS_MIN_PVC_SIZE);
}

/** The StorageProfile offers a Filesystem claim, so a state volume can bind. */
function bindsFilesystem(profile?: StorageProfileKind): boolean {
  return (profile?.status?.claimPropertySets || []).some(
    (p) => (p.volumeMode || 'Filesystem') === 'Filesystem' && (p.accessModes || []).length > 0,
  );
}

/**
 * Drivers whose filesystem is known when the class sets no fstype. Each formats ext4 by
 * default per its documentation (or passes an empty fstype to the Kubernetes mount library,
 * which formats ext4); the hostpath provisioner doesn't format at all.
 */
const KNOWN_DEFAULTS: Array<[RegExp, string]> = [
  [/cephfs\.csi\.ceph\.com/, 'cephfs'],
  [/nfs/i, 'nfs'],
  [/rbd\.csi\.ceph\.com/, 'ext4'], // ceph-csi RBD
  [/^csi\.kubevirt\.io$/, 'ext4'], // KubeVirt CSI (nested clusters)
  [/^ebs\.csi\.aws\.com$/, 'ext4'],
  [/^pd\.csi\.storage\.gke\.io$/, 'ext4'],
  [/^disk\.csi\.azure\.com$/, 'ext4'],
  [/^csi\.vsphere\.vmware\.com$/, 'ext4'],
  [/^cinder\.csi\.openstack\.org$/, 'ext4'],
  [/^kubevirt\.io\.hostpath-provisioner$/, 'hostpath'],
];

/** Filesystem the class formats with, including drivers whose default is known. */
function effectiveFs(sc: StorageClassKind): string {
  const fs = storageClassFsType(sc);
  if (fs) return fs;
  const prov = sc.provisioner || '';
  const hit = KNOWN_DEFAULTS.find(([re]) => re.test(prov));
  return hit ? hit[1] : '';
}

function pickSuggestion(classes: StorageClassKind[], profiles: StorageProfileKind[], current: string): string {
  const profileOf = (name: string) => profiles.find((p) => p.metadata.name === name);
  const fsScore: Record<string, number> = { ext4: 3, cephfs: 2, nfs: 1, hostpath: 1 };
  const ranked = classes
    .filter((sc) => sc.metadata.name !== current && bindsFilesystem(profileOf(sc.metadata.name)))
    .map((sc) => {
      const base = fsScore[effectiveFs(sc)] || 0;
      const bonus = (isTrue(sc, DEFAULT_VIRT_CLASS_ANNOTATION) ? 0.5 : 0) + (isTrue(sc, DEFAULT_CLASS_ANNOTATION) ? 0.25 : 0);
      return { sc, s: base ? base + bonus : 0 };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.sc.metadata.name.localeCompare(b.sc.metadata.name));
  return ranked[0]?.sc.metadata.name || '';
}

export function evaluateVmStateStorage(
  hcoSetting: string | undefined,
  classes: StorageClassKind[],
  profiles: StorageProfileKind[] = [],
  pvcRendering?: boolean,
): VmStateStorage {
  const setting = (hcoSetting || '').trim();
  let source: VmStateStorage['source'] = 'none';
  let candidates: string[] = [];
  if (setting) {
    source = 'hyperconverged';
    candidates = [setting];
  } else {
    const virt = classes.filter((sc) => isTrue(sc, DEFAULT_VIRT_CLASS_ANNOTATION)).map((sc) => sc.metadata.name);
    const def = classes.filter((sc) => isTrue(sc, DEFAULT_CLASS_ANNOTATION)).map((sc) => sc.metadata.name);
    if (virt.length) {
      source = 'default-virt';
      candidates = virt;
    } else if (def.length) {
      source = 'default';
      candidates = def;
    }
  }
  const profileOf = (name: string) => profiles.find((p) => p.metadata.name === name);
  const brokenOne = (name: string) => {
    const c = classes.find((x) => x.metadata.name === name);
    return storageClassFsType(c) === 'xfs' && !xfsSafe(profileOf(name), pvcRendering);
  };
  // With several defaults KubeVirt may pick any of them: report the first broken one.
  const className = candidates.find(brokenOne) || candidates[0] || '';
  const sc = classes.find((c) => c.metadata.name === className);
  const broken = Boolean(className) && brokenOne(className);
  const annotated = quantityBytes(profileOf(className)?.metadata.annotations?.[MIN_PVC_SIZE_ANNOTATION]) > 0;
  const undeclared =
    !broken && Boolean(sc) && !effectiveFs(sc as StorageClassKind) && !xfsSafe(profileOf(className), pvcRendering);
  return {
    className,
    source,
    tiedWith: candidates.filter((c) => c !== className),
    fsType: storageClassFsType(sc),
    broken,
    undeclared,
    annotationIneffective: annotated && pvcRendering === false,
    suggestion: broken || undeclared ? pickSuggestion(classes, profiles, className) : '',
  };
}

/** In-tree provisioners are kubernetes.io/<name>; everything else is a CSI driver. */
function isCsiDriver(provisioner?: string): boolean {
  return Boolean(provisioner) && !provisioner!.startsWith('kubernetes.io/');
}

export type VariantState =
  /** No class with that name yet. */
  | { kind: 'missing' }
  /** The class exists and is an ext4 variant of the same driver, but its StorageProfile has no Filesystem claim yet. */
  | { kind: 'no-claims'; profileExists: boolean }
  /** Ready: it can be offered for VM state. */
  | { kind: 'ready' }
  /** A class with that name exists but isn't an ext4 class of the same driver. */
  | { kind: 'conflict' };

export function variantState(
  variantName: string,
  provisioner: string | undefined,
  classes: StorageClassKind[],
  profiles: StorageProfileKind[],
): VariantState {
  const existing = classes.find((c) => c.metadata.name === variantName);
  if (!existing) return { kind: 'missing' };
  if (existing.provisioner !== provisioner || effectiveFs(existing) !== 'ext4') return { kind: 'conflict' };
  const profile = profiles.find((p) => p.metadata.name === variantName);
  if (!bindsFilesystem(profile)) return { kind: 'no-claims', profileExists: Boolean(profile) };
  return { kind: 'ready' };
}

/** Filesystem claim property sets of a profile (status, as CDI computed them), to copy onto the variant's profile. */
export function filesystemClaims(profile?: StorageProfileKind): Array<{ accessModes?: string[]; volumeMode?: string }> {
  return (profile?.status?.claimPropertySets || []).filter((p) => (p.volumeMode || 'Filesystem') === 'Filesystem' && (p.accessModes || []).length);
}

export function claimsPatchCommand(profileName: string, claims: Array<{ accessModes?: string[]; volumeMode?: string }>): string {
  const sets = claims.length ? claims : [{ accessModes: ['ReadWriteOnce'], volumeMode: 'Filesystem' }];
  return `oc patch storageprofile ${profileName} --type merge -p '${JSON.stringify({ spec: { claimPropertySets: sets } })}'`;
}

/** XFS-only mount options that would break an ext4 mount. */
const XFS_ONLY_MOUNT_OPTIONS = /^(nouuid|logbufs=|logbsize=|allocsize=|inode64|inode32|largeio|swalloc|attr2|noattr2|pquota|uquota|gquota|prjquota|grpquota|usrquota)/;

/**
 * A copy of a StorageClass that formats with ext4: same provisioner, parameters, reclaim
 * policy, binding mode, expansion and topology; fstype set to ext4; XFS-only mount options
 * dropped; never marked default.
 */
export function ext4Variant(sc: StorageClassKind, nameOverride?: string): StorageClassKind & { apiVersion: string; kind: string } {
  // Write ext4 under the key the source class uses: drivers that format at CreateVolume read
  // their own parameter (Portworx fs, in-tree fsType) and may ignore the CSI key.
  const parameters = { ...(sc.parameters || {}) };
  const keys = FSTYPE_KEYS.filter((k) => k in parameters);
  keys.forEach((k) => (parameters[k] = 'ext4'));
  if (!keys.length) parameters[isCsiDriver(sc.provisioner) ? 'csi.storage.k8s.io/fstype' : 'fsType'] = 'ext4';
  const base = sc.metadata.name.replace(/-(xfs|filesystem|fs)$/, '').slice(0, 253 - '-ext4'.length);
  const out: StorageClassKind & { apiVersion: string; kind: string } = {
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    metadata: {
      name: nameOverride || `${base}-ext4`,
      annotations: { description: `ext4 variant of ${sc.metadata.name} (for small Filesystem volumes such as VM state)` },
    },
    provisioner: sc.provisioner,
    parameters,
  };
  if (sc.reclaimPolicy) out.reclaimPolicy = sc.reclaimPolicy;
  if (sc.volumeBindingMode) out.volumeBindingMode = sc.volumeBindingMode;
  if (sc.allowVolumeExpansion !== undefined) out.allowVolumeExpansion = sc.allowVolumeExpansion;
  if (sc.allowedTopologies) out.allowedTopologies = sc.allowedTopologies;
  const mounts = (sc.mountOptions || []).filter((o) => !XFS_ONLY_MOUNT_OPTIONS.test(o));
  if (mounts.length) out.mountOptions = mounts;
  return out;
}

/** Minimal YAML for the copy box (flat maps and lists of strings only). */
export function storageClassYaml(sc: ReturnType<typeof ext4Variant>): string {
  const q = (v: unknown) => JSON.stringify(v);
  const lines = [`apiVersion: ${sc.apiVersion}`, `kind: ${sc.kind}`, 'metadata:', `  name: ${sc.metadata.name}`];
  if (sc.metadata.annotations) {
    lines.push('  annotations:');
    Object.entries(sc.metadata.annotations).forEach(([k, v]) => lines.push(`    ${k}: ${q(v)}`));
  }
  lines.push(`provisioner: ${sc.provisioner}`, 'parameters:');
  Object.entries(sc.parameters || {}).forEach(([k, v]) => lines.push(`  ${k}: ${q(v)}`));
  if (sc.reclaimPolicy) lines.push(`reclaimPolicy: ${sc.reclaimPolicy}`);
  if (sc.volumeBindingMode) lines.push(`volumeBindingMode: ${sc.volumeBindingMode}`);
  if (sc.allowVolumeExpansion !== undefined) lines.push(`allowVolumeExpansion: ${sc.allowVolumeExpansion}`);
  if (sc.mountOptions?.length) {
    lines.push('mountOptions:');
    sc.mountOptions.forEach((o) => lines.push(`  - ${q(o)}`));
  }
  if (sc.allowedTopologies) lines.push(`allowedTopologies: ${JSON.stringify(sc.allowedTopologies)}`);
  return lines.join('\n');
}

export function vmStateStorageCommand(hcoNamespace: string, hcoName: string, className: string): string {
  // Explicit v1beta1, like the plugin (in v1 the field is spec.storage.vmStateStorageClass).
  return `oc patch hyperconverged.v1beta1.hco.kubevirt.io ${hcoName} -n ${hcoNamespace} --type merge -p '{"spec":{"vmStateStorageClass":"${className}"}}'`;
}

export function minPvcSizeCommand(className: string): string {
  return `oc annotate storageprofile ${className} ${MIN_PVC_SIZE_ANNOTATION}=${XFS_MIN_PVC_SIZE} --overwrite`;
}
