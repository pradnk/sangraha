/**
 * Finding every uploaded file a submission refers to.
 *
 * This is what ties photographs to the record that owns them, and what tells
 * erasure which objects to destroy. Missing one has two distinct costs: an
 * unclaimed file becomes an orphan nothing can reach, and — the one that
 * matters — a photograph of somebody who asked to be forgotten survives their
 * erasure because nothing knew it was theirs.
 */
import { describe, expect, it } from 'vitest';
import { collectAttachmentIds } from '../attachments';
import { field, version } from './fixtures';

const PHOTO = '11111111-1111-1111-1111-111111111111';
const SIGNATURE = '22222222-2222-2222-2222-222222222222';
const FILE = '33333333-3333-3333-3333-333333333333';

describe('collectAttachmentIds', () => {
  it('finds each kind of attachment', () => {
    const form = version(1, [
      field('name', 'short_text'),
      field('face', 'photo'),
      field('consent_form', 'file'),
      field('signed', 'signature'),
    ]);

    const found = collectAttachmentIds(form, {
      name: 'Sunita Devi',
      face: PHOTO,
      consent_form: FILE,
      signed: SIGNATURE,
    });

    expect(found.sort()).toEqual([PHOTO, SIGNATURE, FILE].sort());
  });

  it('ignores answers that are not attachments', () => {
    // A text answer that happens to be a uuid — a subject reference, an
    // external id someone pasted — must not be claimed as a file.
    const form = version(1, [
      field('note', 'short_text'),
      field('who', 'subject_ref'),
    ]);

    expect(collectAttachmentIds(form, { note: PHOTO, who: SIGNATURE })).toEqual([]);
  });

  it('reaches into repeating sections', () => {
    /*
     * The case that would otherwise be missed. A household roster with a photo
     * of each member holds its attachments one level down, and a walk that only
     * looked at top-level answers would strand every one of them.
     */
    const group = field('members', 'repeat_group', { id: 'group-1' });
    const form = version(1, [
      field('village', 'short_text'),
      group,
      field('member_name', 'short_text', { parentGroupId: 'group-1' }),
      field('member_photo', 'photo', { parentGroupId: 'group-1' }),
    ]);

    const found = collectAttachmentIds(form, {
      village: 'Rampur',
      members: [
        { member_name: 'Ramesh', member_photo: PHOTO },
        { member_name: 'Sita', member_photo: SIGNATURE },
      ],
    });

    expect(found.sort()).toEqual([PHOTO, SIGNATURE].sort());
  });

  it('skips a question that was left unanswered', () => {
    const form = version(1, [field('face', 'photo'), field('scan', 'file')]);

    expect(collectAttachmentIds(form, { face: null, scan: '' })).toEqual([]);
    expect(collectAttachmentIds(form, {})).toEqual([]);
  });

  it('reads a multi-value attachment answer', () => {
    // `maxCount` on a photo question allows more than one, stored as an array.
    const form = version(1, [field('photos', 'photo')]);

    expect(collectAttachmentIds(form, { photos: [PHOTO, FILE] }).sort()).toEqual(
      [PHOTO, FILE].sort(),
    );
  });

  it('returns each id once, however many questions point at it', () => {
    const form = version(1, [field('a', 'photo'), field('b', 'photo')]);

    expect(collectAttachmentIds(form, { a: PHOTO, b: PHOTO })).toEqual([PHOTO]);
  });

  it('survives a repeat whose entries are not objects', () => {
    // Corrupt or hand-edited data must not take down the send path.
    const group = field('members', 'repeat_group', { id: 'group-1' });
    const form = version(1, [group, field('m', 'photo', { parentGroupId: 'group-1' })]);

    expect(collectAttachmentIds(form, { members: ['nonsense', null, 7] })).toEqual([]);
  });
});
