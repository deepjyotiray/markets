import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArchivePage, parseArchiveTimestamp } from './truth-social-archive-backfill.mjs';

test('parseArchiveTimestamp converts archive ET label to UTC iso', () => {
  assert.equal(parseArchiveTimestamp('June 14, 2026, 2:41 PM'), '2026-06-14T18:41:00.000Z');
});

test('parseArchivePage extracts status fields and next cursor', () => {
  const html = `
    <div class="status" data-status-url="https://trumpstruth.org/statuses/1">
      <div class="status__header">
        <div class="status-info__meta">
          <a href="#" class="status-info__meta-item">@realDonaldTrump</a> · <a href="https://trumpstruth.org/statuses/1" class="status-info__meta-item">June 14, 2026, 2:41 PM</a>
        </div>
        <div class="status-header__right">
          <a href="https://truthsocial.com/@realDonaldTrump/116749924240483636" target="_blank" class="status__external-link">Original Post</a>
        </div>
      </div>
      <div class="status__body">
        <div class="status__content"><p>Hello <strong>world</strong></p></div>
        <div class="status__attachments">
          <div class="status-attachment status-attachment--image">
            <a href="https://truth-archive.example.com/image.jpg"></a>
          </div>
        </div>
      </div>
      <div class="status__footer"></div>
      <a href="https://trumpstruth.org?sort=desc&amp;per_page=100&amp;cursor=abc">Next Page</a>
    </div>
  `;
  const parsed = parseArchivePage(html);
  assert.equal(parsed.statuses.length, 1);
  assert.equal(parsed.statuses[0].dedupeId, '116749924240483636');
  assert.equal(parsed.statuses[0].publishedAt, '2026-06-14T18:41:00.000Z');
  assert.equal(parsed.statuses[0].body, 'Hello world');
  assert.equal(parsed.statuses[0].mediaAttachments[0].type, 'image');
  assert.equal(parsed.nextHref, '?sort=desc&per_page=100&cursor=abc');
});
