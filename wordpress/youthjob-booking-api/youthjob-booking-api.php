<?php
/**
 * Plugin Name: YouthJob Booking API
 * Description: Free WordPress-based diagnose and interview booking API with company isolation and Google Calendar sync.
 * Version: 1.0.0
 * Author: YouthJob
 */

if (!defined('ABSPATH')) {
  exit;
}

final class YouthJob_Booking_API {
  const OPTION_KEY = 'youthjob_booking_api_settings';
  const REST_NAMESPACE = 'youthjob/v1';
  const TOP_AGENT_COUNT = 3;
  const HOLD_TTL_MINUTES = 10;
  const MONTHLY_LIMIT = 14;

  public static function init() {
    add_action('rest_api_init', [__CLASS__, 'register_routes']);
    add_action('admin_menu', [__CLASS__, 'register_admin_menu']);
    add_action('admin_init', [__CLASS__, 'register_settings']);
    add_action('admin_post_youthjob_save_company', [__CLASS__, 'handle_save_company']);
    add_action('admin_post_youthjob_delete_company', [__CLASS__, 'handle_delete_company']);
  }

  public static function activate() {
    global $wpdb;
    require_once ABSPATH . 'wp-admin/includes/upgrade.php';

    $charset = $wpdb->get_charset_collate();
    $prefix = $wpdb->prefix . 'yj_';

    $sql_applicants = "CREATE TABLE {$prefix}applicants (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      completed_at DATETIME NOT NULL,
      payload LONGTEXT NOT NULL,
      answers_json LONGTEXT NULL,
      selected_agents TEXT NULL,
      reservation_count INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL,
      PRIMARY KEY (id),
      KEY idx_completed_at (completed_at)
    ) $charset;";

    $sql_reservations = "CREATE TABLE {$prefix}reservations (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      reservation_hash VARCHAR(255) NOT NULL,
      agent_name VARCHAR(255) NOT NULL,
      reservation_date DATE NOT NULL,
      reservation_time VARCHAR(32) NOT NULL,
      status VARCHAR(32) NOT NULL,
      hold_token VARCHAR(128) NULL,
      hold_expires_at DATETIME NULL,
      booked_at DATETIME NULL,
      applicant_name VARCHAR(255) NULL,
      applicant_tel VARCHAR(64) NULL,
      applicant_email VARCHAR(255) NULL,
      calendar_id VARCHAR(255) NULL,
      calendar_event_id VARCHAR(255) NULL,
      calendar_event_url TEXT NULL,
      updated_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_reservation_hash (reservation_hash),
      KEY idx_agent_date_time (agent_name, reservation_date, reservation_time),
      KEY idx_status (status)
    ) $charset;";

    $sql_company = "CREATE TABLE {$prefix}company_tokens (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      agent_name VARCHAR(255) NOT NULL,
      company_token VARCHAR(255) NOT NULL,
      calendar_id VARCHAR(255) NULL,
      slot_candidates TEXT NULL,
      category VARCHAR(255) NULL,
      description TEXT NULL,
      prefectures TEXT NULL,
      jobs TEXT NULL,
      industries TEXT NULL,
      display_count INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_agent_name (agent_name),
      KEY idx_company_token (company_token)
    ) $charset;";

    dbDelta($sql_applicants);
    dbDelta($sql_reservations);
    dbDelta($sql_company);
  }

  public static function register_routes() {
    register_rest_route(self::REST_NAMESPACE, '/booking', [
      'methods' => WP_REST_Server::CREATABLE,
      'callback' => [__CLASS__, 'handle_booking'],
      'permission_callback' => '__return_true',
    ]);

    register_rest_route(self::REST_NAMESPACE, '/company-reservations', [
      'methods' => WP_REST_Server::CREATABLE,
      'callback' => [__CLASS__, 'handle_company_reservations'],
      'permission_callback' => '__return_true',
    ]);
  }

  public static function handle_booking(WP_REST_Request $request) {
    $payload = self::read_payload($request);
    $action = sanitize_text_field($payload['action'] ?? '');

    try {
      switch ($action) {
        case 'diagnose':
          return self::ok(self::action_diagnose($payload));
        case 'get_availability':
          return self::ok(self::action_get_availability($payload));
        case 'reserve_slot':
          return self::ok(self::action_reserve_slot($payload));
        case 'reserve':
          return self::ok(self::action_reserve($payload));
        case 'update_reservation_status':
          return self::ok(self::action_update_reservation_status($payload));
        default:
          return self::error('Unsupported action', 400);
      }
    } catch (Exception $e) {
      return self::error($e->getMessage(), 400);
    }
  }

  public static function handle_company_reservations(WP_REST_Request $request) {
    $payload = self::read_payload($request);

    $agent_name = sanitize_text_field($payload['agent_name'] ?? '');
    $token = sanitize_text_field($payload['company_token'] ?? '');
    if ($agent_name === '' || $token === '') {
      return self::error('agent_name and company_token are required', 400);
    }

    global $wpdb;
    $company_table = $wpdb->prefix . 'yj_company_tokens';
    $reservations_table = $wpdb->prefix . 'yj_reservations';

    $company = $wpdb->get_row($wpdb->prepare(
      "SELECT * FROM {$company_table} WHERE agent_name = %s LIMIT 1",
      $agent_name
    ), ARRAY_A);
    if (!$company || !hash_equals((string)$company['company_token'], $token)) {
      return self::error('invalid company token', 403);
    }

    $rows = $wpdb->get_results($wpdb->prepare(
      "SELECT reservation_hash, agent_name, reservation_date, reservation_time, status, applicant_name, applicant_tel, applicant_email, booked_at, updated_at, calendar_event_url
       FROM {$reservations_table}
       WHERE agent_name = %s
       ORDER BY reservation_date ASC, reservation_time ASC",
      $agent_name
    ), ARRAY_A);

    return self::ok([
      'agent_name' => $agent_name,
      'monthly_limit' => self::MONTHLY_LIMIT,
      'reservations' => array_map(function($row) {
        return [
          'reservation_hash' => $row['reservation_hash'],
          'date' => self::to_ymd_slash($row['reservation_date']),
          'time' => self::normalize_slot($row['reservation_time']),
          'status' => strtolower((string)$row['status']),
          'applicant_name' => (string)$row['applicant_name'],
          'applicant_tel' => (string)$row['applicant_tel'],
          'applicant_email' => (string)$row['applicant_email'],
          'booked_at_jst' => self::format_jst($row['booked_at']),
          'updated_at_jst' => self::format_jst($row['updated_at']),
          'calendar_event_url' => (string)$row['calendar_event_url'],
        ];
      }, $rows ?: []),
    ]);
  }

  private static function action_diagnose(array $payload) {
    $agents = self::get_agents();
    if (empty($agents)) {
      return ['agents' => []];
    }

    $living_prefecture = sanitize_text_field($payload['living_prefecture'] ?? '');
    $interest_jobs = self::split_csv($payload['interest_jobs'] ?? '');
    $interest_industries = self::split_csv($payload['interest_industries'] ?? '');

    foreach ($agents as &$agent) {
      $score = 0;
      $reasons = [];

      if ($living_prefecture !== '' && in_array($living_prefecture, self::split_csv($agent['prefectures'] ?? ''), true)) {
        $score += 40;
        $reasons[] = '居住地と対応エリアが一致';
      }

      if (self::has_intersection($interest_jobs, self::split_csv($agent['jobs'] ?? ''))) {
        $score += 35;
        $reasons[] = '興味職種との一致度が高い';
      }
      if (self::has_intersection($interest_industries, self::split_csv($agent['industries'] ?? ''))) {
        $score += 25;
        $reasons[] = '興味業界との一致度が高い';
      }

      $agent['_score'] = $score;
      $agent['_reasons'] = !empty($reasons) ? $reasons : ['ご回答との一致度が高いエージェントです'];
    }
    unset($agent);

    usort($agents, function($a, $b) {
      $score = ($b['_score'] ?? 0) <=> ($a['_score'] ?? 0);
      if ($score !== 0) {
        return $score;
      }
      $a_count = (int)($a['display_count'] ?? 0);
      $b_count = (int)($b['display_count'] ?? 0);
      return $a_count <=> $b_count;
    });

    $picked = array_slice($agents, 0, min(self::TOP_AGENT_COUNT, count($agents)));
    foreach ($picked as $picked_agent) {
      self::increment_display_count((string)$picked_agent['agent_name']);
    }

    return [
      'agents' => array_map(function($agent) {
        return [
          'name' => (string)($agent['agent_name'] ?? 'おすすめエージェント'),
          'category' => (string)($agent['category'] ?? '20代向け特化'),
          'description' => (string)($agent['description'] ?? ''),
          'slotCandidates' => self::normalize_slot_candidates($agent['slot_candidates'] ?? ''),
          'reasons' => array_slice($agent['_reasons'] ?? [], 0, 3),
        ];
      }, $picked),
    ];
  }

  private static function action_get_availability(array $payload) {
    $agent_name = sanitize_text_field($payload['agent_name'] ?? '');
    if ($agent_name === '') {
      throw new Exception('agent_name is required');
    }

    $days = isset($payload['days']) ? (int)$payload['days'] : 31;
    if ($days < 7) $days = 7;
    if ($days > 60) $days = 60;

    $slot_candidates = self::normalize_slot_candidates($payload['slot_candidates'] ?? '');
    if (empty($slot_candidates)) {
      $slot_candidates = self::resolve_agent_slots($agent_name);
    }
    if (empty($slot_candidates)) {
      $slot_candidates = self::default_slots();
    }

    $today = new DateTimeImmutable('today', wp_timezone());
    $end = $today->modify('+' . ($days - 1) . ' day');

    $rows = self::get_reservations_for_window($agent_name, $today, $end);
    $taken = [];
    foreach ($rows as $row) {
      $date = self::to_ymd_dash($row['reservation_date']);
      $time = self::normalize_slot($row['reservation_time']);
      if ($date === '' || $time === '') continue;
      if (!self::is_blocking_status((string)$row['status'], $row['hold_expires_at'] ?? null)) continue;
      if (!isset($taken[$date])) $taken[$date] = [];
      $taken[$date][$time] = true;
    }

    $calendar_taken = self::get_calendar_busy_slots($agent_name, $today, $end, $slot_candidates);
    foreach ($calendar_taken as $date => $slots) {
      if (!isset($taken[$date])) $taken[$date] = [];
      foreach ($slots as $slot => $flag) {
        $taken[$date][$slot] = true;
      }
    }

    $month_counts = self::count_booked_by_month($agent_name, $today, $end);
    $available = [];
    $busy_days = [];

    for ($i = 0; $i < $days; $i++) {
      $date = $today->modify("+{$i} day");
      $date_str = $date->format('Y-m-d');
      $month_key = $date->format('Y-m');
      $weekday = (int)$date->format('w');

      if ($weekday === 0 || $weekday === 6) {
        $available[$date_str] = [];
        $busy_days[] = $date_str;
        continue;
      }
      if (($month_counts[$month_key] ?? 0) >= self::MONTHLY_LIMIT) {
        $available[$date_str] = [];
        $busy_days[] = $date_str;
        continue;
      }

      $free = [];
      foreach ($slot_candidates as $slot) {
        if (!isset($taken[$date_str][$slot])) {
          $free[] = $slot;
        }
      }
      $available[$date_str] = $free;
      if (empty($free)) {
        $busy_days[] = $date_str;
      }
    }

    return [
      'agent_name' => $agent_name,
      'available_slots_by_date' => $available,
      'busy_days' => $busy_days,
      'slot_candidates' => $slot_candidates,
      'monthly_limit' => self::MONTHLY_LIMIT,
      'booked_count_by_month' => $month_counts,
    ];
  }

  private static function action_reserve_slot(array $payload) {
    global $wpdb;
    $table = $wpdb->prefix . 'yj_reservations';

    $agent_name = sanitize_text_field($payload['agent_name'] ?? '');
    $date = self::to_ymd_dash($payload['date'] ?? '');
    $time = self::normalize_slot($payload['time'] ?? '');
    $incoming_hold_token = sanitize_text_field($payload['hold_token'] ?? '');

    if ($agent_name === '' || $date === '' || $time === '') {
      throw new Exception('agent_name, date, time are required');
    }

    $hash = self::build_reservation_hash($agent_name, $date, $time);
    $row = $wpdb->get_row($wpdb->prepare(
      "SELECT * FROM {$table} WHERE reservation_hash = %s LIMIT 1",
      $hash
    ), ARRAY_A);

    $now = current_time('mysql', true);
    if ($row) {
      $status = strtolower((string)$row['status']);
      if ($status === 'booked') {
        return ['conflict' => true, 'error' => 'その時間枠はすでに予約済みです。'];
      }
      if ($status === 'holding' && !self::is_hold_expired($row['hold_expires_at'] ?? null)) {
        $latest_hold_token = (string)($row['hold_token'] ?? '');
        if ($incoming_hold_token !== '' && $latest_hold_token !== '' && hash_equals($latest_hold_token, $incoming_hold_token)) {
          $expiry = gmdate('Y-m-d H:i:s', time() + self::HOLD_TTL_MINUTES * 60);
          $wpdb->update($table, [
            'hold_expires_at' => $expiry,
            'updated_at' => $now,
          ], ['id' => (int)$row['id']]);
          return [
            'reservation_hash' => $hash,
            'hold_token' => $latest_hold_token,
            'hold_expires_at_iso' => get_gmt_from_date($expiry, 'c'),
          ];
        }
        return ['conflict' => true, 'error' => 'その時間枠は他ユーザーが仮予約中です。'];
      }
    }

    if (self::is_slot_blocked_by_calendar($agent_name, $date, $time, (string)($row['calendar_event_id'] ?? ''))) {
      return ['conflict' => true, 'error' => '担当者の予定と重複しているため、この時間は予約できません。'];
    }

    $hold_token = $incoming_hold_token !== '' ? $incoming_hold_token : wp_generate_uuid4();
    $hold_expires = gmdate('Y-m-d H:i:s', time() + self::HOLD_TTL_MINUTES * 60);

    if ($row) {
      $wpdb->update($table, [
        'status' => 'holding',
        'hold_token' => $hold_token,
        'hold_expires_at' => $hold_expires,
        'updated_at' => $now,
      ], ['id' => (int)$row['id']]);
    } else {
      $inserted = $wpdb->insert($table, [
        'reservation_hash' => $hash,
        'agent_name' => $agent_name,
        'reservation_date' => $date,
        'reservation_time' => $time,
        'status' => 'holding',
        'hold_token' => $hold_token,
        'hold_expires_at' => $hold_expires,
        'updated_at' => $now,
        'created_at' => $now,
      ]);
      if ($inserted === false && strpos((string)$wpdb->last_error, 'Duplicate') !== false) {
        return ['conflict' => true, 'error' => 'その時間枠は先に予約が入りました。別の日程を選択してください。'];
      }
    }

    return [
      'reservation_hash' => $hash,
      'hold_token' => $hold_token,
      'hold_expires_at_iso' => get_gmt_from_date($hold_expires, 'c'),
    ];
  }

  private static function action_reserve(array $payload) {
    global $wpdb;
    $table_res = $wpdb->prefix . 'yj_reservations';
    $table_app = $wpdb->prefix . 'yj_applicants';

    $details = $payload['reservation_details'] ?? [];
    if (is_string($details) && $details !== '') {
      $decoded = json_decode($details, true);
      if (is_array($decoded)) {
        $details = $decoded;
      }
    }
    if (!is_array($details)) {
      throw new Exception('reservation_details is required');
    }

    $name = sanitize_text_field($payload['name'] ?? $payload['applicant_name'] ?? '');
    $tel = sanitize_text_field($payload['tel'] ?? $payload['applicant_tel'] ?? '');
    $email = sanitize_email($payload['email'] ?? $payload['applicant_email'] ?? '');
    $now = current_time('mysql', true);

    $results = [];
    $calendar_sync = [];
    $month_cache = [];

    foreach ($details as $detail) {
      if (!is_array($detail)) continue;
      $agent_name = sanitize_text_field($detail['agent_name'] ?? '');
      $date = self::to_ymd_dash($detail['date'] ?? '');
      $time = self::normalize_slot($detail['time'] ?? '');
      if ($agent_name === '' || $date === '' || $time === '') {
        throw new Exception('reservation_details has invalid entry');
      }
      $hash = sanitize_text_field($detail['reservation_hash'] ?? '');
      if ($hash === '') {
        $hash = self::build_reservation_hash($agent_name, $date, $time);
      }
      $hold_token = sanitize_text_field($detail['hold_token'] ?? '');

      $row = $wpdb->get_row($wpdb->prepare(
        "SELECT * FROM {$table_res} WHERE reservation_hash = %s LIMIT 1",
        $hash
      ), ARRAY_A);
      if (!$row) {
        throw new Exception('予約情報が見つかりません。再度日程を選択してください。');
      }

      $status = strtolower((string)$row['status']);
      if ($status === 'booked') {
        $results[] = ['reservation_hash' => $hash, 'status' => 'already_booked'];
        continue;
      }
      if ($status !== 'holding') {
        throw new Exception('予約ステータスが無効です。再度日程を選択してください。');
      }
      if (self::is_hold_expired($row['hold_expires_at'] ?? null)) {
        throw new Exception('仮予約の保持期限が切れました。再度日程を選択してください。');
      }
      $latest_hold = (string)($row['hold_token'] ?? '');
      if ($latest_hold !== '' && $hold_token !== '' && !hash_equals($latest_hold, $hold_token)) {
        throw new Exception('仮予約トークンが一致しません。再度日程を選択してください。');
      }
      if ($latest_hold !== '' && $hold_token === '') {
        throw new Exception('仮予約情報が不足しています。再度日程を選択してください。');
      }

      $month_key = substr($date, 0, 7);
      $cache_key = $agent_name . '|' . $month_key;
      if (!isset($month_cache[$cache_key])) {
        $month_cache[$cache_key] = self::count_booked_for_month($agent_name, $month_key);
      }
      if ($month_cache[$cache_key] >= self::MONTHLY_LIMIT) {
        throw new Exception('この会社の当月面談枠（14件）は上限に達しています。');
      }
      if (self::is_slot_blocked_by_calendar($agent_name, $date, $time, (string)($row['calendar_event_id'] ?? ''))) {
        throw new Exception('担当者の予定と重複しているため、この時間は予約できません。');
      }

      $wpdb->update($table_res, [
        'status' => 'booked',
        'booked_at' => $now,
        'updated_at' => $now,
        'applicant_name' => $name,
        'applicant_tel' => $tel,
        'applicant_email' => $email,
      ], ['id' => (int)$row['id']]);

      $month_cache[$cache_key] += 1;
      $updated = $wpdb->get_row($wpdb->prepare("SELECT * FROM {$table_res} WHERE id = %d", (int)$row['id']), ARRAY_A);
      $sync_result = self::sync_calendar($updated);

      $calendar_sync[] = [
        'reservation_hash' => $hash,
        'calendar' => $sync_result,
      ];
      $results[] = ['reservation_hash' => $hash, 'status' => 'booked'];
    }

    $completed_at_iso = sanitize_text_field($payload['completed_at_iso'] ?? '');
    $completed_at = $completed_at_iso !== '' ? get_date_from_gmt(gmdate('Y-m-d H:i:s', strtotime($completed_at_iso)), 'Y-m-d H:i:s') : current_time('mysql');
    $app_payload = $payload;
    unset($app_payload['action']);

    $wpdb->insert($table_app, [
      'completed_at' => $completed_at,
      'payload' => wp_json_encode($app_payload, JSON_UNESCAPED_UNICODE),
      'answers_json' => wp_json_encode($payload, JSON_UNESCAPED_UNICODE),
      'selected_agents' => sanitize_text_field($payload['selected_agents'] ?? ''),
      'reservation_count' => count($details),
      'created_at' => $now,
    ]);

    return [
      'sheet' => 'wp_applicants',
      'row' => (int)$wpdb->insert_id,
      'reservation_results' => $results,
      'calendar_sync' => $calendar_sync,
    ];
  }

  private static function action_update_reservation_status(array $payload) {
    global $wpdb;
    $table = $wpdb->prefix . 'yj_reservations';

    $status = strtolower(sanitize_text_field($payload['status'] ?? ''));
    $allowed = ['canceled', 'done', 'no_show', 'booked'];
    if (!in_array($status, $allowed, true)) {
      throw new Exception('status must be canceled, done, no_show, or booked');
    }

    $hash = sanitize_text_field($payload['reservation_hash'] ?? '');
    if ($hash === '') {
      $agent_name = sanitize_text_field($payload['agent_name'] ?? '');
      $date = self::to_ymd_dash($payload['date'] ?? '');
      $time = self::normalize_slot($payload['time'] ?? '');
      if ($agent_name === '' || $date === '' || $time === '') {
        throw new Exception('reservation_hash or (agent_name/date/time) is required');
      }
      $hash = self::build_reservation_hash($agent_name, $date, $time);
    }

    $row = $wpdb->get_row($wpdb->prepare(
      "SELECT * FROM {$table} WHERE reservation_hash = %s LIMIT 1",
      $hash
    ), ARRAY_A);
    if (!$row) {
      throw new Exception('reservation not found');
    }

    if ($status === 'booked') {
      $month_key = substr(self::to_ymd_dash($row['reservation_date']), 0, 7);
      if (self::count_booked_for_month((string)$row['agent_name'], $month_key) >= self::MONTHLY_LIMIT) {
        throw new Exception('この会社の当月面談枠（14件）は上限に達しています。');
      }
      if (self::is_slot_blocked_by_calendar((string)$row['agent_name'], self::to_ymd_dash($row['reservation_date']), self::normalize_slot($row['reservation_time']), (string)($row['calendar_event_id'] ?? ''))) {
        throw new Exception('担当者の予定と重複しているため、この時間は予約できません。');
      }
    }

    $now = current_time('mysql', true);
    $wpdb->update($table, [
      'status' => $status,
      'updated_at' => $now,
      'booked_at' => $status === 'booked' ? $now : ($row['booked_at'] ?? null),
    ], ['id' => (int)$row['id']]);

    $updated = $wpdb->get_row($wpdb->prepare("SELECT * FROM {$table} WHERE id = %d", (int)$row['id']), ARRAY_A);
    self::sync_calendar($updated);

    return [
      'reservation_hash' => $hash,
      'status' => $status,
    ];
  }

  private static function sync_calendar(array $reservation) {
    $agent_name = (string)($reservation['agent_name'] ?? '');
    $status = strtolower((string)($reservation['status'] ?? ''));
    $calendar_id = self::resolve_calendar_id($agent_name, (string)($reservation['calendar_id'] ?? ''));
    if ($calendar_id === '') {
      return ['ok' => false, 'skipped' => true, 'reason' => 'calendar_id is not configured'];
    }

    $token_json = self::get_setting('google_service_account_json');
    if ($token_json === '') {
      return ['ok' => false, 'skipped' => true, 'reason' => 'google_service_account_json is empty'];
    }
    $service_json = json_decode($token_json, true);
    if (!is_array($service_json)) {
      return ['ok' => false, 'skipped' => true, 'reason' => 'invalid service account json'];
    }

    $date = self::to_ymd_dash($reservation['reservation_date'] ?? '');
    $slot = self::normalize_slot($reservation['reservation_time'] ?? '');
    $range = self::parse_slot_range($date, $slot);
    if (!$range) {
      return ['ok' => false, 'skipped' => true, 'reason' => 'invalid date/time slot'];
    }

    $event_id = (string)($reservation['calendar_event_id'] ?? '');
    if ($status === 'canceled') {
      if ($event_id !== '') {
        self::google_calendar_delete_event($service_json, $calendar_id, $event_id);
      }
      self::update_calendar_linkage((int)$reservation['id'], $calendar_id, '', '');
      return ['ok' => true, 'deleted' => true];
    }

    if ($status !== 'booked') {
      return ['ok' => true, 'skipped' => true, 'reason' => 'status is not booked'];
    }
    if ($event_id !== '') {
      return ['ok' => true, 'skipped' => true, 'reason' => 'event already linked', 'event_id' => $event_id];
    }

    $name = (string)($reservation['applicant_name'] ?? '求職者');
    $tel = (string)($reservation['applicant_tel'] ?? '');
    $email = (string)($reservation['applicant_email'] ?? '');
    $summary = '【面談予約】' . $name . ' 様';
    $description = implode("\n", [
      '予約ハッシュ: ' . (string)($reservation['reservation_hash'] ?? ''),
      'エージェント: ' . $agent_name,
      '氏名: ' . $name,
      '電話番号: ' . $tel,
      'メール: ' . $email,
    ]);
    $event = self::google_calendar_create_event($service_json, $calendar_id, $summary, $description, $range['start'], $range['end']);
    if (!$event || empty($event['id'])) {
      return ['ok' => false, 'skipped' => true, 'reason' => 'calendar event create failed'];
    }

    self::update_calendar_linkage((int)$reservation['id'], $calendar_id, (string)$event['id'], (string)($event['htmlLink'] ?? ''));
    return [
      'ok' => true,
      'event_id' => (string)$event['id'],
      'event_url' => (string)($event['htmlLink'] ?? ''),
      'calendar_id' => $calendar_id,
    ];
  }

  private static function is_slot_blocked_by_calendar(string $agent_name, string $date, string $slot, string $ignore_event_id = '') {
    $calendar_id = self::resolve_calendar_id($agent_name, '');
    if ($calendar_id === '') return false;

    $token_json = self::get_setting('google_service_account_json');
    if ($token_json === '') return false;
    $service_json = json_decode($token_json, true);
    if (!is_array($service_json)) return false;

    $range = self::parse_slot_range($date, $slot);
    if (!$range) return false;

    $events = self::google_calendar_list_events($service_json, $calendar_id, $range['start'], $range['end']);
    if (!is_array($events)) return false;

    foreach ($events as $event) {
      $event_id = (string)($event['id'] ?? '');
      if ($ignore_event_id !== '' && $event_id !== '' && hash_equals($ignore_event_id, $event_id)) {
        continue;
      }
      $start = (string)($event['start']['dateTime'] ?? '');
      $end = (string)($event['end']['dateTime'] ?? '');
      if ($start === '' || $end === '') continue;
      if (self::ranges_overlap($range['start'], $range['end'], $start, $end)) {
        return true;
      }
    }
    return false;
  }

  private static function get_calendar_busy_slots(string $agent_name, DateTimeImmutable $start, DateTimeImmutable $end, array $slots) {
    $calendar_id = self::resolve_calendar_id($agent_name, '');
    if ($calendar_id === '') return [];

    $token_json = self::get_setting('google_service_account_json');
    if ($token_json === '') return [];
    $service_json = json_decode($token_json, true);
    if (!is_array($service_json)) return [];

    $events = self::google_calendar_list_events(
      $service_json,
      $calendar_id,
      $start->format(DateTimeInterface::ATOM),
      $end->modify('+1 day')->format(DateTimeInterface::ATOM)
    );
    if (!is_array($events) || empty($events)) return [];

    $busy = [];
    $period_days = (int)$end->diff($start)->format('%a') + 1;
    for ($i = 0; $i < $period_days; $i++) {
      $date = $start->modify("+{$i} day");
      $date_str = $date->format('Y-m-d');
      foreach ($slots as $slot) {
        $range = self::parse_slot_range($date_str, $slot);
        if (!$range) continue;
        foreach ($events as $event) {
          $ev_start = (string)($event['start']['dateTime'] ?? '');
          $ev_end = (string)($event['end']['dateTime'] ?? '');
          if ($ev_start === '' || $ev_end === '') continue;
          if (self::ranges_overlap($range['start'], $range['end'], $ev_start, $ev_end)) {
            if (!isset($busy[$date_str])) $busy[$date_str] = [];
            $busy[$date_str][$slot] = true;
            break;
          }
        }
      }
    }
    return $busy;
  }

  private static function parse_slot_range(string $date, string $slot) {
    if (!preg_match('/^(\d{2}):(\d{2})～(\d{2}):(\d{2})$/u', $slot, $m)) {
      return null;
    }
    try {
      $tz = wp_timezone();
      $start = new DateTimeImmutable($date . ' ' . $m[1] . ':' . $m[2] . ':00', $tz);
      $end = new DateTimeImmutable($date . ' ' . $m[3] . ':' . $m[4] . ':00', $tz);
      if ($end <= $start) return null;
      return [
        'start' => $start->format(DateTimeInterface::ATOM),
        'end' => $end->format(DateTimeInterface::ATOM),
      ];
    } catch (Exception $e) {
      return null;
    }
  }

  private static function ranges_overlap(string $start_a, string $end_a, string $start_b, string $end_b) {
    try {
      $a1 = new DateTimeImmutable($start_a);
      $a2 = new DateTimeImmutable($end_a);
      $b1 = new DateTimeImmutable($start_b);
      $b2 = new DateTimeImmutable($end_b);
      return $a1 < $b2 && $b1 < $a2;
    } catch (Exception $e) {
      return false;
    }
  }

  private static function google_calendar_list_events(array $service_json, string $calendar_id, string $time_min, string $time_max) {
    $token = self::google_get_access_token($service_json);
    if ($token === '') return [];

    $url = add_query_arg([
      'singleEvents' => 'true',
      'orderBy' => 'startTime',
      'timeMin' => $time_min,
      'timeMax' => $time_max,
      'maxResults' => 250,
    ], 'https://www.googleapis.com/calendar/v3/calendars/' . rawurlencode($calendar_id) . '/events');

    $resp = wp_remote_get($url, [
      'headers' => ['Authorization' => 'Bearer ' . $token],
      'timeout' => 20,
    ]);
    if (is_wp_error($resp)) return [];
    $code = wp_remote_retrieve_response_code($resp);
    if ($code < 200 || $code >= 300) return [];
    $json = json_decode((string)wp_remote_retrieve_body($resp), true);
    if (!is_array($json)) return [];
    return isset($json['items']) && is_array($json['items']) ? $json['items'] : [];
  }

  private static function google_calendar_create_event(array $service_json, string $calendar_id, string $summary, string $description, string $start_iso, string $end_iso) {
    $token = self::google_get_access_token($service_json);
    if ($token === '') return null;

    $body = [
      'summary' => $summary,
      'description' => $description,
      'start' => ['dateTime' => $start_iso, 'timeZone' => wp_timezone_string()],
      'end' => ['dateTime' => $end_iso, 'timeZone' => wp_timezone_string()],
    ];
    $url = 'https://www.googleapis.com/calendar/v3/calendars/' . rawurlencode($calendar_id) . '/events';
    $resp = wp_remote_post($url, [
      'headers' => [
        'Authorization' => 'Bearer ' . $token,
        'Content-Type' => 'application/json',
      ],
      'body' => wp_json_encode($body, JSON_UNESCAPED_UNICODE),
      'timeout' => 20,
    ]);
    if (is_wp_error($resp)) return null;
    $code = wp_remote_retrieve_response_code($resp);
    if ($code < 200 || $code >= 300) return null;
    $json = json_decode((string)wp_remote_retrieve_body($resp), true);
    return is_array($json) ? $json : null;
  }

  private static function google_calendar_delete_event(array $service_json, string $calendar_id, string $event_id) {
    $token = self::google_get_access_token($service_json);
    if ($token === '') return false;
    $url = 'https://www.googleapis.com/calendar/v3/calendars/' . rawurlencode($calendar_id) . '/events/' . rawurlencode($event_id);
    $resp = wp_remote_request($url, [
      'method' => 'DELETE',
      'headers' => ['Authorization' => 'Bearer ' . $token],
      'timeout' => 20,
    ]);
    if (is_wp_error($resp)) return false;
    $code = wp_remote_retrieve_response_code($resp);
    return $code >= 200 && $code < 300;
  }

  private static function google_get_access_token(array $service_json) {
    $cache_key = 'youthjob_google_access_token';
    $cached = get_transient($cache_key);
    if (is_array($cached) && !empty($cached['token'])) {
      return (string)$cached['token'];
    }

    if (empty($service_json['client_email']) || empty($service_json['private_key']) || empty($service_json['token_uri'])) {
      return '';
    }

    $header = self::base64url_encode(wp_json_encode(['alg' => 'RS256', 'typ' => 'JWT']));
    $now = time();
    $claims = [
      'iss' => $service_json['client_email'],
      'scope' => 'https://www.googleapis.com/auth/calendar',
      'aud' => $service_json['token_uri'],
      'exp' => $now + 3500,
      'iat' => $now,
    ];
    $payload = self::base64url_encode(wp_json_encode($claims));
    $unsigned = $header . '.' . $payload;

    $private_key = openssl_pkey_get_private($service_json['private_key']);
    if (!$private_key) return '';
    $signature = '';
    $ok = openssl_sign($unsigned, $signature, $private_key, OPENSSL_ALGO_SHA256);
    if (!$ok) return '';
    $jwt = $unsigned . '.' . self::base64url_encode($signature);

    $resp = wp_remote_post($service_json['token_uri'], [
      'timeout' => 20,
      'headers' => ['Content-Type' => 'application/x-www-form-urlencoded'],
      'body' => [
        'grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        'assertion' => $jwt,
      ],
    ]);
    if (is_wp_error($resp)) return '';
    $code = wp_remote_retrieve_response_code($resp);
    if ($code < 200 || $code >= 300) return '';
    $json = json_decode((string)wp_remote_retrieve_body($resp), true);
    if (!is_array($json) || empty($json['access_token'])) return '';

    $token = (string)$json['access_token'];
    $expires_in = isset($json['expires_in']) ? max(60, (int)$json['expires_in'] - 120) : 3300;
    set_transient($cache_key, ['token' => $token], $expires_in);
    return $token;
  }

  private static function base64url_encode(string $value) {
    return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
  }

  private static function update_calendar_linkage(int $reservation_id, string $calendar_id, string $event_id, string $event_url) {
    global $wpdb;
    $table = $wpdb->prefix . 'yj_reservations';
    $wpdb->update($table, [
      'calendar_id' => $calendar_id,
      'calendar_event_id' => $event_id,
      'calendar_event_url' => $event_url,
      'updated_at' => current_time('mysql', true),
    ], ['id' => $reservation_id]);
  }

  private static function count_booked_for_month(string $agent_name, string $month_key) {
    global $wpdb;
    $table = $wpdb->prefix . 'yj_reservations';
    $start = $month_key . '-01';
    $end = date('Y-m-t', strtotime($start));
    $count = $wpdb->get_var($wpdb->prepare(
      "SELECT COUNT(*) FROM {$table}
       WHERE agent_name = %s
       AND status = 'booked'
       AND reservation_date BETWEEN %s AND %s",
      $agent_name, $start, $end
    ));
    return (int)$count;
  }

  private static function count_booked_by_month(string $agent_name, DateTimeImmutable $start, DateTimeImmutable $end) {
    global $wpdb;
    $table = $wpdb->prefix . 'yj_reservations';
    $rows = $wpdb->get_results($wpdb->prepare(
      "SELECT DATE_FORMAT(reservation_date, '%%Y-%%m') AS month_key, COUNT(*) AS cnt
       FROM {$table}
       WHERE agent_name = %s
       AND status = 'booked'
       AND reservation_date BETWEEN %s AND %s
       GROUP BY month_key",
      $agent_name,
      $start->format('Y-m-d'),
      $end->format('Y-m-d')
    ), ARRAY_A);

    $counts = [];
    foreach ($rows ?: [] as $row) {
      $month_key = (string)($row['month_key'] ?? '');
      $counts[$month_key] = (int)$row['cnt'];
    }
    return $counts;
  }

  private static function get_reservations_for_window(string $agent_name, DateTimeImmutable $start, DateTimeImmutable $end) {
    global $wpdb;
    $table = $wpdb->prefix . 'yj_reservations';
    return $wpdb->get_results($wpdb->prepare(
      "SELECT reservation_hash, reservation_date, reservation_time, status, hold_expires_at
       FROM {$table}
       WHERE agent_name = %s
       AND reservation_date BETWEEN %s AND %s",
      $agent_name,
      $start->format('Y-m-d'),
      $end->format('Y-m-d')
    ), ARRAY_A);
  }

  private static function is_blocking_status(string $status, $hold_expires_at) {
    $normalized = strtolower($status);
    if ($normalized === 'booked') return true;
    if ($normalized === 'holding' && !self::is_hold_expired($hold_expires_at)) return true;
    return false;
  }

  private static function is_hold_expired($hold_expires_at) {
    if (!$hold_expires_at) return true;
    $ts = strtotime((string)$hold_expires_at);
    if (!$ts) return true;
    return $ts <= time();
  }

  private static function resolve_calendar_id(string $agent_name, string $fallback) {
    if ($fallback !== '') return $fallback;
    global $wpdb;
    $company_table = $wpdb->prefix . 'yj_company_tokens';
    $calendar_id = $wpdb->get_var($wpdb->prepare(
      "SELECT calendar_id FROM {$company_table} WHERE agent_name = %s LIMIT 1",
      $agent_name
    ));
    return sanitize_text_field((string)$calendar_id);
  }

  private static function default_slots() {
    return [
      '10:00～11:00',
      '11:00～12:00',
      '12:00～13:00',
      '13:00～14:00',
      '14:00～15:00',
      '15:00～16:00',
      '16:00～17:00',
      '17:00～18:00',
    ];
  }

  private static function resolve_agent_slots(string $agent_name) {
    global $wpdb;
    $company_table = $wpdb->prefix . 'yj_company_tokens';
    $raw = $wpdb->get_var($wpdb->prepare(
      "SELECT slot_candidates FROM {$company_table} WHERE agent_name = %s LIMIT 1",
      $agent_name
    ));
    $slots = self::normalize_slot_candidates((string)$raw);
    return !empty($slots) ? $slots : self::default_slots();
  }

  private static function build_reservation_hash(string $agent_name, string $date, string $time) {
    return $agent_name . '|' . $date . '|' . $time;
  }

  private static function normalize_slot_candidates($value) {
    $items = [];
    if (is_array($value)) {
      $items = $value;
    } else {
      $raw = trim((string)$value);
      if ($raw !== '') {
        $decoded = json_decode($raw, true);
        if (is_array($decoded)) {
          $items = $decoded;
        } else {
          $items = preg_split('/[\r\n,]+/u', $raw);
        }
      }
    }
    $normalized = [];
    foreach ($items as $item) {
      $slot = self::normalize_slot((string)$item);
      if ($slot !== '' && !in_array($slot, $normalized, true)) {
        $normalized[] = $slot;
      }
    }
    return $normalized;
  }

  private static function normalize_slot($value) {
    $raw = preg_replace('/\s+/u', '', (string)$value);
    if ($raw === '') return '';
    if (!preg_match('/^(\d{1,2}):(\d{2})[〜～~\-－—–](\d{1,2}):(\d{2})$/u', $raw, $m)) {
      return (string)$value;
    }
    return sprintf('%02d:%02d～%02d:%02d', (int)$m[1], (int)$m[2], (int)$m[3], (int)$m[4]);
  }

  private static function to_ymd_dash($value) {
    $raw = trim((string)$value);
    if ($raw === '') return '';
    if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $raw)) return $raw;
    if (preg_match('/^\d{4}\/\d{2}\/\d{2}$/', $raw)) return str_replace('/', '-', $raw);
    $ts = strtotime($raw);
    return $ts ? wp_date('Y-m-d', $ts, wp_timezone()) : '';
  }

  private static function to_ymd_slash($value) {
    $dash = self::to_ymd_dash($value);
    return $dash !== '' ? str_replace('-', '/', $dash) : '';
  }

  private static function format_jst($value) {
    if (!$value) return '';
    $ts = strtotime((string)$value);
    if (!$ts) return '';
    return wp_date('Y/m/d/ H:i', $ts, wp_timezone());
  }

  private static function split_csv($value) {
    if (is_array($value)) {
      $arr = $value;
    } else {
      $arr = preg_split('/[\r\n,、]+/u', (string)$value);
    }
    $res = [];
    foreach ($arr as $item) {
      $v = trim((string)$item);
      if ($v !== '' && !in_array($v, $res, true)) {
        $res[] = $v;
      }
    }
    return $res;
  }

  private static function has_intersection(array $a, array $b) {
    if (empty($a) || empty($b)) return false;
    foreach ($a as $v) {
      if (in_array($v, $b, true)) return true;
    }
    return false;
  }

  private static function get_agents() {
    global $wpdb;
    $table = $wpdb->prefix . 'yj_company_tokens';
    $rows = $wpdb->get_results("
      SELECT agent_name, slot_candidates, category, description, prefectures, jobs, industries, display_count
      FROM {$table}
      ORDER BY agent_name ASC
    ", ARRAY_A);
    $agents = [];
    foreach ($rows ?: [] as $row) {
      $agents[] = [
        'agent_name' => (string)$row['agent_name'],
        'category' => (string)($row['category'] ?? '20代向け特化'),
        'description' => (string)($row['description'] ?? '企業担当者と直接日程調整できます。'),
        'prefectures' => (string)($row['prefectures'] ?? ''),
        'jobs' => (string)($row['jobs'] ?? ''),
        'industries' => (string)($row['industries'] ?? ''),
        'slot_candidates' => (string)$row['slot_candidates'],
        'display_count' => (int)($row['display_count'] ?? 0),
      ];
    }
    return $agents;
  }

  private static function increment_display_count($agent_name) {
    if ($agent_name === '') return;
    global $wpdb;
    $table = $wpdb->prefix . 'yj_company_tokens';
    $wpdb->query($wpdb->prepare(
      "UPDATE {$table}
       SET display_count = COALESCE(display_count, 0) + 1, updated_at = %s
       WHERE agent_name = %s",
      current_time('mysql', true),
      $agent_name
    ));
  }

  public static function register_admin_menu() {
    add_menu_page(
      'YouthJob Booking API',
      'YouthJob Booking API',
      'manage_options',
      'youthjob-booking-api',
      [__CLASS__, 'render_admin_page'],
      'dashicons-calendar-alt',
      58
    );
  }

  public static function register_settings() {
    register_setting('youthjob_booking_api_group', self::OPTION_KEY);
  }

  public static function render_admin_page() {
    if (!current_user_can('manage_options')) {
      return;
    }
    $settings = get_option(self::OPTION_KEY, []);
    $service_json = isset($settings['google_service_account_json']) ? (string)$settings['google_service_account_json'] : '';
    global $wpdb;
    $table = $wpdb->prefix . 'yj_company_tokens';
    $companies = $wpdb->get_results("SELECT * FROM {$table} ORDER BY agent_name ASC", ARRAY_A);
    ?>
    <div class="wrap">
      <h1>YouthJob Booking API 設定</h1>
      <p>WordPress 無料構成で高速予約APIを動作させます。Google Calendar連携が不要なら JSON は空欄で構いません。</p>
      <form method="post" action="options.php">
        <?php settings_fields('youthjob_booking_api_group'); ?>
        <table class="form-table" role="presentation">
          <tr>
            <th scope="row">Google Service Account JSON</th>
            <td>
              <textarea name="<?php echo esc_attr(self::OPTION_KEY); ?>[google_service_account_json]" rows="16" cols="120" class="large-text code"><?php echo esc_textarea($service_json); ?></textarea>
              <p class="description">Google Calendar API を自動作成/空き確認に使います。カレンダー共有先は service account の client_email に編集権限を付与してください。</p>
            </td>
          </tr>
        </table>
        <?php submit_button('保存'); ?>
      </form>

      <hr />
      <h2>フロント用 API URL</h2>
      <p><code><?php echo esc_html(rest_url(self::REST_NAMESPACE . '/booking')); ?></code></p>
      <p>company reservations API: <code><?php echo esc_html(rest_url(self::REST_NAMESPACE . '/company-reservations')); ?></code></p>

      <hr />
      <h2>会社設定（企業別管理）</h2>
      <p>1社1行で登録してください。company_token を会社側画面の認証に使います。</p>
      <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
        <?php wp_nonce_field('youthjob_save_company'); ?>
        <input type="hidden" name="action" value="youthjob_save_company" />
        <table class="form-table" role="presentation">
          <tr><th>会社名(agent_name)</th><td><input type="text" name="agent_name" class="regular-text" required /></td></tr>
          <tr><th>company_token</th><td><input type="text" name="company_token" class="regular-text" required /></td></tr>
          <tr><th>calendar_id</th><td><input type="text" name="calendar_id" class="regular-text" /></td></tr>
          <tr><th>slot_candidates</th><td><textarea name="slot_candidates" rows="2" class="large-text" placeholder="10:00～11:00,11:00～12:00"></textarea></td></tr>
          <tr><th>prefectures</th><td><textarea name="prefectures" rows="2" class="large-text" placeholder="東京都,神奈川県"></textarea></td></tr>
          <tr><th>jobs</th><td><textarea name="jobs" rows="2" class="large-text" placeholder="営業,事務,IT"></textarea></td></tr>
          <tr><th>industries</th><td><textarea name="industries" rows="2" class="large-text" placeholder="IT,人材,メーカー"></textarea></td></tr>
          <tr><th>category</th><td><input type="text" name="category" class="regular-text" value="20代向け特化" /></td></tr>
          <tr><th>description</th><td><textarea name="description" rows="3" class="large-text"></textarea></td></tr>
        </table>
        <?php submit_button('会社を保存'); ?>
      </form>

      <h3>登録済み会社</h3>
      <table class="widefat striped">
        <thead>
          <tr>
            <th>会社名</th>
            <th>token</th>
            <th>calendar_id</th>
            <th>対応都道府県</th>
            <th>職種</th>
            <th>業界</th>
            <th>表示回数</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <?php if (empty($companies)) : ?>
            <tr><td colspan="8">まだ会社設定がありません。</td></tr>
          <?php else : foreach ($companies as $company) : ?>
            <tr>
              <td><?php echo esc_html((string)$company['agent_name']); ?></td>
              <td><code><?php echo esc_html((string)$company['company_token']); ?></code></td>
              <td><?php echo esc_html((string)$company['calendar_id']); ?></td>
              <td><?php echo esc_html((string)$company['prefectures']); ?></td>
              <td><?php echo esc_html((string)$company['jobs']); ?></td>
              <td><?php echo esc_html((string)$company['industries']); ?></td>
              <td><?php echo (int)($company['display_count'] ?? 0); ?></td>
              <td>
                <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" onsubmit="return confirm('削除しますか？');">
                  <?php wp_nonce_field('youthjob_delete_company'); ?>
                  <input type="hidden" name="action" value="youthjob_delete_company" />
                  <input type="hidden" name="agent_name" value="<?php echo esc_attr((string)$company['agent_name']); ?>" />
                  <button type="submit" class="button button-link-delete">削除</button>
                </form>
              </td>
            </tr>
          <?php endforeach; endif; ?>
        </tbody>
      </table>
    </div>
    <?php
  }

  public static function handle_save_company() {
    if (!current_user_can('manage_options')) {
      wp_die('forbidden');
    }
    check_admin_referer('youthjob_save_company');
    global $wpdb;
    $table = $wpdb->prefix . 'yj_company_tokens';

    $agent_name = sanitize_text_field($_POST['agent_name'] ?? '');
    $company_token = sanitize_text_field($_POST['company_token'] ?? '');
    if ($agent_name === '' || $company_token === '') {
      wp_safe_redirect(admin_url('admin.php?page=youthjob-booking-api'));
      exit;
    }

    $now = current_time('mysql', true);
    $data = [
      'agent_name' => $agent_name,
      'company_token' => $company_token,
      'calendar_id' => sanitize_text_field($_POST['calendar_id'] ?? ''),
      'slot_candidates' => wp_kses_post($_POST['slot_candidates'] ?? ''),
      'prefectures' => wp_kses_post($_POST['prefectures'] ?? ''),
      'jobs' => wp_kses_post($_POST['jobs'] ?? ''),
      'industries' => wp_kses_post($_POST['industries'] ?? ''),
      'category' => sanitize_text_field($_POST['category'] ?? '20代向け特化'),
      'description' => wp_kses_post($_POST['description'] ?? ''),
      'updated_at' => $now,
    ];

    $exists = $wpdb->get_var($wpdb->prepare(
      "SELECT id FROM {$table} WHERE agent_name = %s LIMIT 1",
      $agent_name
    ));
    if ($exists) {
      $wpdb->update($table, $data, ['agent_name' => $agent_name]);
    } else {
      $data['created_at'] = $now;
      $wpdb->insert($table, $data);
    }

    wp_safe_redirect(admin_url('admin.php?page=youthjob-booking-api'));
    exit;
  }

  public static function handle_delete_company() {
    if (!current_user_can('manage_options')) {
      wp_die('forbidden');
    }
    check_admin_referer('youthjob_delete_company');
    $agent_name = sanitize_text_field($_POST['agent_name'] ?? '');
    if ($agent_name !== '') {
      global $wpdb;
      $table = $wpdb->prefix . 'yj_company_tokens';
      $wpdb->delete($table, ['agent_name' => $agent_name]);
    }
    wp_safe_redirect(admin_url('admin.php?page=youthjob-booking-api'));
    exit;
  }

  private static function get_setting(string $key) {
    $settings = get_option(self::OPTION_KEY, []);
    return isset($settings[$key]) ? (string)$settings[$key] : '';
  }

  private static function ok(array $payload) {
    return new WP_REST_Response(array_merge(['ok' => true], $payload), 200);
  }

  private static function error(string $message, int $status = 400) {
    return new WP_REST_Response(['ok' => false, 'error' => $message], $status);
  }

  private static function read_payload(WP_REST_Request $request) {
    $payload = $request->get_json_params();
    if (is_array($payload) && !empty($payload)) {
      return $payload;
    }
    $raw = (string)$request->get_body();
    if ($raw !== '') {
      $decoded = json_decode($raw, true);
      if (is_array($decoded)) {
        return $decoded;
      }
    }
    $params = $request->get_params();
    return is_array($params) ? $params : [];
  }
}

register_activation_hook(__FILE__, ['YouthJob_Booking_API', 'activate']);
YouthJob_Booking_API::init();
