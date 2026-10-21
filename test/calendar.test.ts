import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAVClient, type DAVCalendarObject } from "tsdav";
import ICAL from "ical.js";
import { createModels } from "@earendil-works/pi-ai/models";
import type { JsonObject } from "@earendil-works/pi-durable";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openAssistant, context } from "../src/assistant.ts";
import { readConfig } from "../src/config.ts";
import { calendarExtension } from "../extensions/calendar.ts";

test("iCloud tools read agendas, safely serialize dates, preserve edits, and check versions without a real account", async (t) => {
  const calendar = { url: "https://caldav.icloud.com/test/personal/", displayName: "Personal", components: ["VEVENT"] };
  let objects: DAVCalendarObject[] = [{
    url: calendar.url + "original.ics", etag: '"v1"',
    data: [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN", "BEGIN:VEVENT",
      "UID:original", "DTSTAMP:20300101T000000Z", "DTSTART:20300102T140000Z",
      "DTEND:20300102T150000Z", "SUMMARY:Original", "DESCRIPTION:Keep this",
      "X-EXAMPLE:Keep metadata", "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Reminder",
      "TRIGGER:-PT15M", "END:VALARM", "END:VEVENT", "END:VCALENDAR", "",
    ].join("\r\n"),
  }];
  let writes = 0;
  let conflict = false;
  t.mock.method(globalThis, "fetch", async () => { throw new Error("No real calendar network calls in tests"); });
  t.mock.method(DAVClient.prototype, "login", async () => {});
  t.mock.method(DAVClient.prototype, "fetchCalendars", async () => [calendar, {
    url: "https://caldav.icloud.com/test/reminders/", components: ["VTODO"], displayName: "Reminders",
  }]);
  t.mock.method(DAVClient.prototype, "fetchCalendarObjects", async (
    args: Parameters<DAVClient["fetchCalendarObjects"]>[0],
  ) => args?.objectUrls ? objects.filter((object) => args.objectUrls!.includes(object.url)) : objects);
  t.mock.method(DAVClient.prototype, "createCalendarObject", async (
    args: Parameters<DAVClient["createCalendarObject"]>[0],
  ) => {
    writes++;
    objects.push({ url: new URL(args.filename, args.calendar.url).href, data: args.iCalString, etag: '"created"' });
    return new Response(null, { status: 201 });
  });
  t.mock.method(DAVClient.prototype, "updateCalendarObject", async (
    args: Parameters<DAVClient["updateCalendarObject"]>[0],
  ) => {
    writes++;
    if (conflict) return new Response(null, { status: 412 });
    const index = objects.findIndex((object) => object.url === args.calendarObject.url);
    assert.equal(args.calendarObject.etag, objects[index].etag);
    objects[index] = { ...args.calendarObject, etag: '"updated"' };
    return new Response(null, { status: 204 });
  });
  t.mock.method(DAVClient.prototype, "deleteCalendarObject", async (
    args: Parameters<DAVClient["deleteCalendarObject"]>[0],
  ) => {
    writes++;
    assert.equal(args.calendarObject.etag, objects.find((object) => object.url === args.calendarObject.url)?.etag);
    objects = objects.filter((object) => object.url !== args.calendarObject.url);
    return new Response(null, { status: 204 });
  });
  const dataDir = await mkdtemp(join(tmpdir(), "personal-pi-calendar-"));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const assistant = await openAssistant({
    ...readConfig(), dataDir, timezone: "America/New_York", mcpServers: {}, enableShell: false,
    telegramToken: "", telegramChat: "", searxngUrl: "", firecrawlUrl: "", lightpandaUrl: "",
    appleId: "test@example.invalid", appleAppPassword: "test-only-password", appleCalendarUrl: calendar.url,
  }, { models, model: { provider: "faux", modelId: "faux-1" } });
  const run = async (tool: string, args: JsonObject) => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: "toolUse" }),
      fauxAssistantMessage("Finished."),
    ]);
    assert.equal((await (await assistant.submit("Calendar test.")).wait(context)).status, "done");
    const result = (await assistant.root.context(context)).messages.findLast((message) => message.role === "toolResult");
    assert.ok(result?.role === "toolResult");
    const content = result.content.find((part) => part.type === "text");
    return { error: Boolean(result.isError), text: JSON.stringify(result.content),
      value: !result.isError && content?.type === "text" ? JSON.parse(content.text) : null };
  };
  try {
    const listed = await run("calendar_read", { action: "calendars" });
    assert.equal(listed.error, false);
    assert.ok(listed.text.includes("Personal"));
    assert.ok(!listed.text.includes("Reminders"));
    const agenda = await run("calendar_read", {
      action: "events", start: "2030-01-01T00:00:00-05:00", end: "2030-01-08T00:00:00-05:00",
    });
    assert.equal(agenda.error, false);
    assert.ok(agenda.text.includes("Original"));
    assert.equal(agenda.value.events[0].start, "2030-01-02T14:00:00Z");
    assert.match(agenda.value.events[0].localStart, /9:00\s*AM EST/u);
    assert.match(agenda.value.events[0].localEnd, /10:00\s*AM EST/u);
    assert.equal(agenda.value.events[0].localTimezone, "America/New_York");
    const winter = objects[0].data;
    objects[0].data = String(winter).replaceAll("20300102", "20300702");
    const summer = await run("calendar_read", {
      action: "events", start: "2030-07-01T00:00:00-04:00", end: "2030-07-08T00:00:00-04:00",
    });
    assert.match(summer.value.events[0].localStart, /10:00\s*AM EDT/u);
    assert.match(summer.value.events[0].localEnd, /11:00\s*AM EDT/u);
    objects[0].data = winter;
    assert.ok((await run("calendar_read", { action: "events", start: "2030-01-01", end: "2030-01-02" })).error);
    const title = "Study, math;\nBEGIN:VEVENT";
    const created = await run("calendar_write", {
      action: "create", title, start: "2030-01-03T10:00:00-05:00", end: "2030-01-03T11:00:00-05:00",
    });
    assert.equal(created.error, false);
    const component = new ICAL.Component(ICAL.parse(String(objects[1].data)));
    assert.equal(component.getAllSubcomponents("vevent").length, 1);
    const event = new ICAL.Event(component.getFirstSubcomponent("vevent")!);
    assert.equal(event.summary, title);
    assert.equal(event.startDate.toString(), "2030-01-03T15:00:00Z");
    assert.equal((await run("calendar_write", {
      action: "create", title: "All day", start: "2030-01-04", end: "2030-01-05",
    })).error, false);
    assert.ok(new ICAL.Event(new ICAL.Component(ICAL.parse(String(objects[2].data))).getFirstSubcomponent("vevent")!).startDate.isDate);
    const allDay = await run("calendar_read", {
      action: "events", start: "2030-01-01T00:00:00-05:00", end: "2030-01-08T00:00:00-05:00",
    });
    const dayEvent = allDay.value.events.find((item: { allDay: boolean }) => item.allDay);
    assert.equal(dayEvent.localStart, "2030-01-04");
    assert.equal(dayEvent.localEnd, "2030-01-05", "all-day exclusive end dates must not shift with timezone");
    assert.equal((await run("calendar_write", { action: "update", eventUrl: objects[0].url, title: "Updated" })).error, false);
    const updated = new ICAL.Component(ICAL.parse(String(objects[0].data))).getFirstSubcomponent("vevent")!;
    assert.equal(updated.getFirstPropertyValue("description"), "Keep this");
    assert.equal(updated.getFirstPropertyValue("x-example"), "Keep metadata");
    assert.ok(updated.getFirstSubcomponent("valarm"));
    conflict = true;
    const failed = await run("calendar_write", { action: "update", eventUrl: objects[0].url, title: "Stale edit" });
    assert.ok(failed.error && failed.text.includes("concurrently"));
    const beforeInvalid = writes;
    assert.ok((await run("calendar_write", { action: "delete", eventUrl: "https://other.invalid/event.ics" })).error);
    assert.ok((await run("calendar_write", { action: "create", title: "Bad", start: "2030-01-04T10:00:00", end: "2030-01-04T11:00:00" })).error);
    assert.ok((await run("calendar_write", { action: "create", title: "Invalid day", start: "2030-02-30T10:00:00Z", end: "2030-02-30T11:00:00Z" })).error);
    assert.equal(writes, beforeInvalid);
    assert.equal((await run("calendar_write", { action: "delete", eventUrl: objects[1].url })).error, false);
    assert.equal(objects.length, 2);
    objects[0].data = String(objects[0].data).replace("END:VEVENT", "RRULE:FREQ=DAILY\r\nEND:VEVENT");
    const beforeRecurring = writes;
    assert.ok((await run("calendar_write", { action: "delete", eventUrl: objects[0].url })).error);
    assert.equal(writes, beforeRecurring);
  } finally {
    await assistant.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("iCloud tools are absent until credentials are configured", () => {
  assert.equal(calendarExtension({ ...readConfig(), appleId: "", appleAppPassword: "" }).tools?.length, 0);
});
