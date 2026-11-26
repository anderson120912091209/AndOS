import AppKit
import SwiftUI

/// Render the agent's notch forms over a simulated menu bar + notch + wallpaper, offscreen —
/// no window, server or permissions. Triggered by RELAY_RENDER_AGENT_SHOTS=<dir>.
@MainActor
func renderAgentShots(to dir: String) {
  let notchW: CGFloat = 185
  let topInset: CGFloat = 32

  let email = AgentTicket(
    id: "t1", kind: "agent", title: "Email Alex", utterance: "email Alex saying I'll be 20 minutes late", status: "awaiting_approval",
    updatedAt: 0,
    proposal: .init(
      id: "p1", verb: "Send", summary: "Email to Alex Chen · Running 20 minutes late",
      preview: .init(
        kind: "email", to: ["alex.chen@acme.com"], subject: "Running 20 minutes late",
        body: "Hi Alex,\n\nI'm running about 20 minutes late to the design review — please start without me and I'll catch up on the open questions when I join.\n\nSorry for the shuffle,\nAnderson"
      ),
      decision: nil, committedAt: nil
    ),
    result: nil, error: nil
  )
  let event = AgentTicket(
    id: "t2", kind: "agent", title: "跟小美吃飯", utterance: "下週五晚上七點半跟小美在信義區吃飯", status: "awaiting_approval",
    updatedAt: 0,
    proposal: .init(
      id: "p2", verb: "Add to Calendar", summary: "跟小美吃飯 · 2026-10-30 19:30",
      preview: .init(
        kind: "event", title: "跟小美吃飯", start: "2026-10-30T19:30:00+08:00", end: "2026-10-30T21:00:00+08:00",
        location: "信義區", attendees: ["mei@example.com"]
      ),
      decision: nil, committedAt: nil
    ),
    result: nil, error: nil
  )
  let research = AgentTicket(
    id: "t3", kind: "agent", title: "Compare The Top 3 CRMs", utterance: "research the top 3 CRMs", status: "done", updatedAt: 0,
    proposal: nil,
    result: .init(
      summary: "HubSpot is the best fit for a 5-person team: free core CRM, the cleanest Gmail integration, and you can grow into paid tiers.",
      artifacts: [.init(label: "Runner-up", value: "Pipedrive — best pure sales pipeline"), .init(label: "Sources", value: "6 vendor pages, 3 reviews")]
    ),
    error: nil
  )
  var noRecipient = email
  noRecipient = AgentTicket(
    id: "t4", kind: "agent", title: noRecipient.title, utterance: noRecipient.utterance, status: "awaiting_approval", updatedAt: 0,
    proposal: .init(
      id: "p4", verb: "Send", summary: "Email to someone · Q3 budget",
      preview: .init(kind: "email", to: [], subject: "Q3 budget", body: "Hi,\n\nCould you send me the latest Q3 budget numbers before Friday?\n\nThanks!"),
      decision: nil, committedAt: nil
    ),
    result: nil, error: nil
  )

  func make(_ name: String, width: CGFloat = 560, height: CGFloat = 400, _ configure: (AgentNotchState) -> Void) {
    let s = AgentNotchState()
    s.hasNotch = true
    s.notchWidth = notchW
    s.notchTopInset = topInset
    s.scrollableBody = false
    s.stillTime = 0.27
    s.open = true
    configure(s)

    let content = ZStack(alignment: .top) {
      LinearGradient(
        colors: [Color(red: 0.05, green: 0.10, blue: 0.22), Color(red: 0.16, green: 0.28, blue: 0.47)],
        startPoint: .top, endPoint: .bottom
      )
      Rectangle().fill(Color.white.opacity(0.18)).frame(height: topInset)
      NotchShape(bottomRadius: 8)
        .fill(Color.black)
        .frame(width: notchW, height: topInset)
        .frame(maxWidth: .infinity, alignment: .top)
      AgentNotchView(state: s, actions: AgentActions())
    }
    .frame(width: width, height: height)

    let renderer = ImageRenderer(content: content)
    renderer.scale = 2
    guard
      let img = renderer.nsImage,
      let tiff = img.tiffRepresentation,
      let bmp = NSBitmapImageRep(data: tiff),
      let png = bmp.representation(using: .png, properties: [:])
    else {
      print("render failed: \(name)")
      return
    }
    try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent(name))
    print("rendered \(name)")
  }

  make("agent-working.png", height: 90) { $0.form = .glance(.init(working: ["scout"])) }
  make("agent-ready.png", height: 110) { $0.form = .ready(email) }
  make("agent-card-email.png") { $0.form = .card(email) }
  make("agent-card-sending.png") { s in
    s.form = .card(email)
    s.busy = .sending
  }
  make("agent-card-revising.png") { s in
    s.form = .card(email)
    s.busy = .revising
  }
  make("agent-card-no-recipient.png") { $0.form = .card(noRecipient) }
  make("agent-card-event.png", height: 300) { $0.form = .card(event) }
  make("agent-card-result.png", height: 260) { $0.form = .card(research) }
  let claudeTicket = AgentTicket(
    id: "t5", kind: "agent", title: "email Alex", utterance: "email Alex saying I'll be late", status: "done", updatedAt: 0,
    proposal: nil,
    result: .init(summary: "Claude isn't set up yet.", artifacts: nil, setup: .init(connection: "claude", label: "Set up Claude")),
    error: nil
  )
  make("agent-setup-chin.png", height: 110) { $0.form = .setup(claudeTicket) }
  make("agent-key-card.png", height: 300) { s in
    s.form = .keySetup(.claude(for: claudeTicket))
  }
  make("agent-key-card-typed.png", height: 300) { s in
    s.form = .keySetup(.claude(for: claudeTicket))
    s.keyText = "sk-ant-api03-4f9ac2e1bd77"
  }
  make("agent-key-card-checking.png", height: 300) { s in
    s.form = .keySetup(.claude(for: claudeTicket))
    s.keyText = "sk-ant-api03-4f9ac2e1bd77"
    s.keyStatus = .checking
  }
  make("agent-takeover.png", height: 110) { s in
    s.form = .takeover(.init(ticketID: "t6", reason: "Sign in to Gmail — Relay waits", service: "gmail", viewerURL: nil, id: "tk1"))
  }
  make("agent-badge.png", height: 90) { $0.form = .glance(.init(waiting: 2, kind: "email")) }
  make("agent-toast-sent.png", height: 110) { $0.form = .toast(.init(symbol: "checkmark.circle.fill", text: "Sent to Alex Chen.", tone: .good)) }

  // Answers (packages/shared answer.ts): one line, a card per kind of block, and the reader.
  func answered(_ id: String, _ agent: String, _ place: String, _ answer: AgentTicket.Answer) -> AgentTicket {
    AgentTicket(
      id: id, kind: "agent", title: "", utterance: "", status: "done", updatedAt: 0, proposal: nil,
      result: .init(summary: answer.headline, artifacts: nil, answer: answer, place: place), error: nil, agent: agent
    )
  }
  let uber = answered("a1", "relay", "chin", .init(tone: "answer", headline: "這個月 Uber 花了 NT$3,420 · 14 趟", followups: ["列出每一趟"]))
  let triage = answered("a2", "relay", "card", .init(
    tone: "answer", headline: "3 封要你回，其他都不急", basis: "讀完 40 封未讀",
    block: .init(kind: "list", items: [
      .init(title: "Sam Lee", sub: "合約第 3 條", detail: "要你週五前確認付款條件", tag: "週五前", tone: "amber"),
      .init(title: "林怡君", sub: "面試時間", detail: "問你週二還是週三方便", tag: "要回", tone: "amber"),
      .init(title: "Stripe", sub: "扣款失敗", detail: "信用卡過期，3 天後暫停訂閱", tag: "3 天內", tone: "red"),
    ], more: "還有 37 封不急 · 電子報 21、通知 16"),
    followups: ["回覆 Sam", "約怡君週二", "更新信用卡"]
  ))
  let crm = answered("a3", "scout", "card", .init(
    tone: "answer", headline: "5 人團隊選 HubSpot：免費、Gmail 整合最好", basis: "看了 6 個官網、3 篇評測",
    block: .init(kind: "compare", rows: [
      .init(label: "價格", values: ["免費", "$14/人", "$25/人"]),
      .init(label: "Gmail", values: ["●●●", "●●○", "●○○"]),
      .init(label: "上手", values: ["1 天", "2 天", "1–2 週"]),
      .init(label: "適合", values: ["小團隊", "業務流程", "大公司"]),
    ], columns: ["HubSpot", "Pipedrive", "Salesforce"], pick: 0),
    followups: ["寫成完整報告", "開 HubSpot 帳號"]
  ))
  let meetup = answered("a4", "relay", "card", .init(
    tone: "done", headline: "已幫你報名 Taipei AI Meetup #12", basis: "在 Relay 的電腦上完成",
    block: .init(kind: "facts", rows: [
      .init(label: "時間", value: "11/7（六）14:00–17:00"),
      .init(label: "地點", value: "信義區松仁路 100 號 5F"),
      .init(label: "票號", value: "A-2381"),
      .init(label: "確認信", value: "已寄到你的 Gmail"),
    ]),
    followups: ["加到行事曆", "前一天提醒我", "取消報名"]
  ))
  let interview = answered("a5", "tock", "card", .init(
    tone: "needs_you", headline: "怡君三個時間都可以，你要哪個？", basis: "幫你約林怡君面試",
    block: .init(kind: "choice", options: [
      .init(label: "10/27 週二 10:00–11:00", note: "早上沒有別的會"),
      .init(label: "10/27 週二 15:00–16:00", note: "接在設計評審後"),
      .init(label: "10/28 週三 14:00–15:00"),
    ], recommended: 1)
  ))
  let report = answered("a6", "scout", "reader", .init(
    tone: "answer", headline: "選 HubSpot 免費版；等需要自動寄信再升級 Starter（每人每月 US$20）。", basis: "報告 · 6 個官網、3 篇評測",
    block: .init(kind: "doc", title: "CRM 選型：5 人團隊該用哪一套？", markdown: """
      ## 為什麼是 HubSpot
      你們和客戶的往來幾乎都在 Gmail。HubSpot 的 Gmail 外掛會把信件和開信紀錄自動掛到聯絡人底下，不用手動複製；Pipedrive 也做得到，但 **Email Sync 要另外付費**。

      ## 三家比較
      | | HubSpot | Pipedrive | Salesforce |
      |---|---|---|---|
      | 每人每月 | 免費 → $20 | $14 | $25 |
      | Gmail 整合 | 原生外掛 | 要加購 | 第三方 |
      | 上手時間 | 1 天 | 2 天 | 1–2 週 |

      ## 要注意
      - 免費版只有 1 條 pipeline；要分開「新客」和「續約」就得升級。
      - 舊資料可以直接從試算表匯入，大約 30 分鐘。
      """),
    followups: ["寄給 Sam", "改成英文", "做成 5 頁簡報"]
  ))

  make("answer-chin.png", height: 110) { $0.form = .ready(uber) }
  make("answer-ready-card.png", height: 110) { $0.form = .ready(triage) }
  make("answer-ready-needs-you.png", height: 110) { $0.form = .ready(interview) }
  make("answer-list.png", height: 420) { $0.form = .answer(triage) }
  make("answer-compare.png", height: 380) { $0.form = .answer(crm) }
  make("answer-facts.png", height: 340) { $0.form = .answer(meetup) }
  make("answer-choice.png", height: 360) { $0.form = .answer(interview) }
  make("answer-chin-opened.png", height: 220) { $0.form = .answer(uber) }
  make("answer-reader.png", width: 760, height: 760) { s in
    s.screenHeight = 982
    s.form = .reader(report)
  }

  // Several jobs at once (AgentStack.swift): the glance beside the notch, and the stack opened.
  func job(_ id: String, _ agent: String, _ title: String, step: String, seconds: Double) -> AgentTicket {
    AgentTicket(
      id: id, kind: "agent", title: title, utterance: title, status: "running", updatedAt: 1_000_000,
      proposal: nil, result: nil, error: nil, agent: agent, createdAt: 1_000_000 - seconds * 1000,
      steps: [.init(type: "note", text: "Claimed by worker."), .init(type: "act", text: step)]
    )
  }
  let clinics = job("j1", "scout", "附近有什麼耳鼻喉科", step: "Opening maps.google.com in the browser.", seconds: 42)
  let inbox = job("j2", "echo", "整理收件匣", step: "Reading email 12 of 40 — Stripe: card declined", seconds: 70)
  let signIn = AgentTicket(
    id: "j3", kind: "agent", title: "幫我看今天的 Gmail", utterance: "", status: "needs_input", updatedAt: 0,
    proposal: nil, result: nil, error: nil, takeover: .init(id: "tk2", reason: "Sign in to Gmail", service: "gmail"),
    agent: "relay"
  )
  make("agent-glance-two.png", height: 90) { $0.form = .glance(.init(working: ["scout", "echo"])) }
  make("agent-glance-many.png", height: 90) { $0.form = .glance(.init(working: ["scout", "echo", "quill", "tock"], waiting: 2, kind: "email")) }
  make("agent-glance-back.png", height: 90) { $0.form = .glance(.init(unread: 3, lead: "relay")) }
  make("agent-stack.png", height: 360) { s in
    s.stackRows = [email, signIn, clinics, inbox, uber]
    s.form = .stack
  }
  make("agent-stack-more.png", height: 360) { s in
    s.stackRows = [interview, email, signIn, clinics, inbox, triage, uber]
    s.form = .stack
  }

  // A real task too, when RELAY_RENDER_TICKET=<task.json> (one task from GET /api/tasks): how
  // that answer looks in the notch — its one line, and opened.
  if let path = ProcessInfo.processInfo.environment["RELAY_RENDER_TICKET"],
     let data = FileManager.default.contents(atPath: path),
     let t = try? JSONDecoder().decode(AgentTicket.self, from: data) {
    make("ticket-ready.png", height: 110) { $0.form = .ready(t) }
    if t.answer != nil {
      let reader = t.placement == "reader"
      make("ticket-open.png", width: reader ? 760 : 560, height: reader ? 760 : 520) { s in
        s.screenHeight = 982
        s.form = reader ? .reader(t) : .answer(t)
      }
    }
  }
}
