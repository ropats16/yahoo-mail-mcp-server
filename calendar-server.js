#!/usr/bin/env node

/**
 * Calendar MCP Server (CalDAV) — standalone
 *
 * Connects to any CalDAV calendar server over HTTPS. Defaults to Yahoo
 * Calendar (caldav.calendar.yahoo.com); point it elsewhere with CALDAV_URL.
 *
 * Credentials (environment variables):
 *   EMAIL_ADDRESS  + EMAIL_PASSWORD      — generic names, any provider
 *   YAHOO_EMAIL    + YAHOO_APP_PASSWORD  — also accepted (Yahoo setups)
 *   CALDAV_URL                            — optional, defaults to Yahoo
 *
 * Zero dependencies beyond the MCP SDK: all network calls use the fetch
 * API built into Node 18+. Transport is stdio only (launched and managed
 * by Claude Desktop; opens no network port of its own).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

class CalendarMCPServer {
  constructor() {
    this.server = new Server(
      { name: "caldav-calendar-mcp", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );
    this.calendarListCache = null;
    this.setupToolHandlers();
    this.server.onerror = (error) => console.error("[MCP Error]", error);
    process.on("SIGINT", async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "list_calendars",
          description: "List the calendars available on this account",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "list_events",
          description:
            "List calendar events in a date range (default: the next 7 days). Returns each event's UID, title, start/end times, location and description.",
          inputSchema: {
            type: "object",
            properties: {
              start: {
                type: "string",
                description:
                  "Range start, ISO 8601 with timezone offset (e.g. 2026-08-01T00:00:00+05:30). Default: now.",
              },
              end: {
                type: "string",
                description:
                  "Range end, ISO 8601 with timezone offset. Default: 7 days from now.",
              },
              calendar: {
                type: "string",
                description:
                  "Calendar name (see list_calendars). Default: the account's first calendar.",
              },
            },
          },
        },
        {
          name: "create_event",
          description:
            "Create a calendar event. Include a timezone offset in the ISO timestamps (e.g. 2026-08-01T15:00:00+05:30); times are stored in UTC.",
          inputSchema: {
            type: "object",
            properties: {
              title: { type: "string", description: "Event title" },
              start: {
                type: "string",
                description: "Start time, ISO 8601 with timezone offset",
              },
              end: {
                type: "string",
                description: "End time, ISO 8601 with timezone offset",
              },
              description: {
                type: "string",
                description: "Optional event details",
              },
              location: { type: "string", description: "Optional location" },
              calendar: {
                type: "string",
                description:
                  "Calendar name (see list_calendars). Default: the account's first calendar.",
              },
            },
            required: ["title", "start", "end"],
          },
        },
        {
          name: "delete_event",
          description:
            "Delete a calendar event by its UID (get UIDs from list_events).",
          inputSchema: {
            type: "object",
            properties: {
              uid: {
                type: "string",
                description: "The event UID from list_events",
              },
              calendar: {
                type: "string",
                description:
                  "Calendar name (see list_calendars). Default: the account's first calendar.",
              },
            },
            required: ["uid"],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      try {
        switch (name) {
          case "list_calendars":
            return await this.listCalendarsTool();
          case "list_events":
            return await this.listEvents(
              args?.start,
              args?.end,
              args?.calendar
            );
          case "create_event":
            return await this.createEvent(args.title, args.start, args.end, {
              description: args.description,
              location: args.location,
              calendar: args.calendar,
            });
          case "delete_event":
            return await this.deleteEvent(args.uid, args.calendar);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }] };
      }
    });
  }

  // ---- CalDAV plumbing ---------------------------------------------

  caldavConfig() {
    const base = (
      process.env.CALDAV_URL || "https://caldav.calendar.yahoo.com"
    ).replace(/\/+$/, "");
    const user = process.env.EMAIL_ADDRESS || process.env.YAHOO_EMAIL;
    const password =
      process.env.EMAIL_PASSWORD || process.env.YAHOO_APP_PASSWORD;
    if (!user || !password) {
      throw new Error(
        "Credentials are not set (set EMAIL_ADDRESS + EMAIL_PASSWORD, or YAHOO_EMAIL + YAHOO_APP_PASSWORD)"
      );
    }
    return { base, user, password };
  }

  async caldavRequest(method, url, headers = {}, body = null) {
    const { user, password } = this.caldavConfig();
    const res = await fetch(url, {
      method,
      headers: {
        Authorization:
          "Basic " + Buffer.from(`${user}:${password}`).toString("base64"),
        "Content-Type": "application/xml; charset=utf-8",
        "User-Agent": "caldav-calendar-mcp/1.0",
        ...headers,
      },
      body,
      redirect: "follow",
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Calendar authentication failed (HTTP ${res.status}). Check the app password.`
      );
    }
    if (res.status >= 400) {
      throw new Error(
        `Calendar request failed: ${method} returned HTTP ${res.status}`
      );
    }
    return { status: res.status, text };
  }

  /**
   * Remove XML namespace prefixes (D:, d:, C:, cal:, ...) so parsing
   * works regardless of which prefixes the server chooses.
   */
  stripXmlNamespaces(xml) {
    return xml.replace(/<(\/?)[A-Za-z0-9_-]+:/g, "<$1");
  }

  /**
   * Discover the account's calendars using the standard CalDAV chain:
   * principal URL -> calendar home -> calendar collections.
   * Cached for the life of the process.
   */
  async discoverCalendars() {
    if (this.calendarListCache) return this.calendarListCache;
    const { base } = this.caldavConfig();
    const abs = (href) => (href.startsWith("http") ? href : base + href);

    // Step 1: who am I? (principal URL)
    const principalProbe =
      '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><current-user-principal/></prop></propfind>';
    let principalHref = null;
    for (const path of ["/.well-known/caldav", "/", "/principals/"]) {
      try {
        const r = await this.caldavRequest(
          "PROPFIND",
          base + path,
          { Depth: "0" },
          principalProbe
        );
        const xml = this.stripXmlNamespaces(r.text);
        const m = xml.match(
          /<current-user-principal>[\s\S]*?<href>([^<]+)<\/href>/
        );
        if (m) {
          principalHref = m[1].trim();
          break;
        }
      } catch (e) {
        // Auth errors are fatal; other errors mean "try the next path"
        if (e.message.includes("authentication failed")) throw e;
      }
    }
    if (!principalHref) {
      throw new Error(
        "Could not discover the calendar account (principal) at " +
          base +
          ". The provider may not support CalDAV, or may use a different URL."
      );
    }

    // Step 2: where do my calendars live? (calendar-home-set)
    const homeProbe =
      '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><prop><C:calendar-home-set/></prop></propfind>';
    const rHome = await this.caldavRequest(
      "PROPFIND",
      abs(principalHref),
      { Depth: "0" },
      homeProbe
    );
    const mh = this.stripXmlNamespaces(rHome.text).match(
      /<calendar-home-set>[\s\S]*?<href>([^<]+)<\/href>/
    );
    if (!mh)
      throw new Error("Could not discover the calendar home for this account");

    // Step 3: list the calendar collections in the home
    const listProbe =
      '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><prop><displayname/><resourcetype/><C:supported-calendar-component-set/></prop></propfind>';
    const rList = await this.caldavRequest(
      "PROPFIND",
      abs(mh[1].trim()),
      { Depth: "1" },
      listProbe
    );
    const listXml = this.stripXmlNamespaces(rList.text);

    const calendars = [];
    for (const block of listXml.split(/<response>/).slice(1)) {
      const href = (block.match(/<href>([^<]+)<\/href>/) || [])[1];
      if (!href) continue;
      const isCalendar =
        /<resourcetype>[\s\S]*?<calendar[\s/>][\s\S]*?<\/resourcetype>/.test(
          block
        );
      if (!isCalendar) continue;
      // Skip collections that explicitly exclude events
      const declaresComponents = /<supported-calendar-component-set>/.test(
        block
      );
      if (declaresComponents && !/name="VEVENT"/.test(block)) continue;
      const name = (
        (block.match(/<displayname>([^<]*)<\/displayname>/) || [])[1] ||
        decodeURIComponent(href.replace(/\/+$/, "").split("/").pop())
      ).trim();
      calendars.push({
        name,
        url: abs(href.endsWith("/") ? href : href + "/"),
      });
    }
    if (calendars.length === 0)
      throw new Error("No calendars found on this account");
    this.calendarListCache = calendars;
    return calendars;
  }

  async resolveCalendar(name) {
    const calendars = await this.discoverCalendars();
    if (!name) return calendars[0];
    const found = calendars.find(
      (c) => c.name.toLowerCase() === String(name).toLowerCase()
    );
    if (!found) {
      throw new Error(
        `Calendar "${name}" not found. Available: ${calendars
          .map((c) => c.name)
          .join(", ")}`
      );
    }
    return found;
  }

  // ---- iCalendar (.ics) helpers ------------------------------------

  /** Convert an ISO 8601 timestamp to iCalendar UTC form (20260801T093000Z). */
  toIcsUtc(value, label) {
    const d = new Date(value);
    if (isNaN(d.getTime())) {
      throw new Error(
        `Invalid ${label}: "${value}". Use ISO 8601 with offset, e.g. 2026-08-01T09:00:00+05:30`
      );
    }
    return d
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "");
  }

  escapeIcsText(text) {
    return String(text)
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\r?\n/g, "\\n");
  }

  /** Minimal VEVENT parser: unfold wrapped lines, walk BEGIN/END blocks. */
  parseIcsEvents(ics) {
    const unescapeText = (v) =>
      v
        .replace(/\\n/g, "\n")
        .replace(/\\,/g, ",")
        .replace(/\\;/g, ";")
        .replace(/\\\\/g, "\\");
    const lines = ics
      .replace(/\r\n[ \t]/g, "")
      .replace(/\n[ \t]/g, "")
      .split(/\r?\n/);
    const events = [];
    let current = null;
    for (const line of lines) {
      if (line === "BEGIN:VEVENT") {
        current = {};
        continue;
      }
      if (line === "END:VEVENT") {
        if (current) events.push(current);
        current = null;
        continue;
      }
      if (!current) continue;
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const rawKey = line.slice(0, idx);
      const value = line.slice(idx + 1);
      switch (rawKey.split(";")[0].toUpperCase()) {
        case "UID":
          current.uid = value;
          break;
        case "SUMMARY":
          current.title = unescapeText(value);
          break;
        case "DTSTART":
          current.start = value;
          current.startParams = rawKey.includes(";")
            ? rawKey.split(";").slice(1).join(";")
            : null;
          break;
        case "DTEND":
          current.end = value;
          break;
        case "LOCATION":
          current.location = unescapeText(value);
          break;
        case "DESCRIPTION":
          current.description = unescapeText(value);
          break;
        case "STATUS":
          current.status = value;
          break;
        case "RRULE":
          current.repeats = value;
          break;
      }
    }
    return events;
  }

  /** Render iCalendar times readably; mark all-day and UTC values. */
  formatIcsTime(value, params) {
    if (!value) return "unknown";
    if (/^\d{8}$/.test(value)) {
      return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(
        6,
        8
      )} (all day)`;
    }
    const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
    if (!m) return value;
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
    return m[7] ? `${iso}Z (UTC)` : iso + (params ? ` (${params})` : "");
  }

  // ---- Tools -------------------------------------------------------

  async listCalendarsTool() {
    const calendars = await this.discoverCalendars();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              calendars: calendars.map((c) => c.name),
              count: calendars.length,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  async listEvents(start, end, calendarName) {
    const cal = await this.resolveCalendar(calendarName);
    const startUtc = this.toIcsUtc(start || new Date().toISOString(), "start");
    const endUtc = this.toIcsUtc(
      end || new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      "end"
    );

    const query =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
      "<D:prop><D:getetag/><C:calendar-data/></D:prop>" +
      '<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">' +
      `<C:time-range start="${startUtc}" end="${endUtc}"/>` +
      "</C:comp-filter></C:comp-filter></C:filter></C:calendar-query>";

    const r = await this.caldavRequest(
      "REPORT",
      cal.url,
      { Depth: "1" },
      query
    );
    const xml = this.stripXmlNamespaces(r.text);
    const dataBlocks = [
      ...xml.matchAll(/<calendar-data[^>]*>([\s\S]*?)<\/calendar-data>/g),
    ].map((m) =>
      m[1]
        .replace(/&#13;/g, "\r")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
    );

    const events = dataBlocks.flatMap((b) => this.parseIcsEvents(b));
    events.sort((a, b) => (a.start || "").localeCompare(b.start || ""));

    const formatted = events.map((e) => ({
      uid: e.uid,
      title: e.title || "(no title)",
      start: this.formatIcsTime(e.start, e.startParams),
      end: this.formatIcsTime(e.end),
      location: e.location || null,
      description: e.description || null,
      status: e.status || null,
      repeats: e.repeats || null,
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              calendar: cal.name,
              from: startUtc,
              to: endUtc,
              eventCount: formatted.length,
              events: formatted,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  async createEvent(title, start, end, options = {}) {
    if (!title || !start || !end)
      throw new Error("title, start and end are required");
    const cal = await this.resolveCalendar(options.calendar);
    const uid = `${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 10)}@caldav-calendar-mcp`;
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//caldav-calendar-mcp//EN",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${this.toIcsUtc(new Date().toISOString(), "timestamp")}`,
      `DTSTART:${this.toIcsUtc(start, "start")}`,
      `DTEND:${this.toIcsUtc(end, "end")}`,
      `SUMMARY:${this.escapeIcsText(title)}`,
    ];
    if (options.description)
      lines.push(`DESCRIPTION:${this.escapeIcsText(options.description)}`);
    if (options.location)
      lines.push(`LOCATION:${this.escapeIcsText(options.location)}`);
    lines.push("END:VEVENT", "END:VCALENDAR");

    await this.caldavRequest(
      "PUT",
      `${cal.url}${uid}.ics`,
      {
        "Content-Type": "text/calendar; charset=utf-8",
        "If-None-Match": "*",
      },
      lines.join("\r\n") + "\r\n"
    );

    return {
      content: [
        {
          type: "text",
          text: `Event created in "${cal.name}": ${title}. UID: ${uid}`,
        },
      ],
    };
  }

  async deleteEvent(uid, calendarName) {
    if (!uid) throw new Error("uid is required (get it from list_events)");
    const cal = await this.resolveCalendar(calendarName);

    // Locate the event resource by UID
    const query =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
      "<D:prop><D:getetag/></D:prop>" +
      '<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">' +
      `<C:prop-filter name="UID"><C:text-match>${this.escapeIcsText(
        uid
      )}</C:text-match></C:prop-filter>` +
      "</C:comp-filter></C:comp-filter></C:filter></C:calendar-query>";

    const r = await this.caldavRequest(
      "REPORT",
      cal.url,
      { Depth: "1" },
      query
    );
    const href = (this.stripXmlNamespaces(r.text).match(
      /<href>([^<]+\.ics)<\/href>/
    ) || [])[1];
    if (!href)
      throw new Error(
        `No event with UID "${uid}" found in calendar "${cal.name}"`
      );

    const { base } = this.caldavConfig();
    await this.caldavRequest(
      "DELETE",
      href.startsWith("http") ? href : base + href,
      {}
    );

    return {
      content: [
        {
          type: "text",
          text: `Event ${uid} deleted from "${cal.name}"`,
        },
      ],
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("CalDAV Calendar MCP server running on stdio");
  }
}

const server = new CalendarMCPServer();
server.run().catch(console.error);
