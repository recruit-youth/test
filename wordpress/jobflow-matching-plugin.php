<?php
/**
 * Plugin Name: Jobflow Matching Scheduler
 * Description: 求職者の質問回答 -> 3社提案 -> 日程調整 -> 予約完了導線を1つのショートコードで提供します。
 * Version: 1.0.0
 * Author: Cursor Agent
 */

if (!defined("ABSPATH")) {
    exit;
}

final class Jobflow_Matching_Scheduler_Plugin
{
    private const MONTHLY_LIMIT = 14;
    private const SLOT_MINUTES = 60;
    private const SLOT_HOURS = [10, 11, 13, 14, 15, 16, 17, 18];
    private const OPTION_LINE_URL = "jobflow_line_registration_url";

    /** @var Jobflow_Matching_Scheduler_Plugin|null */
    private static $instance = null;

    /** @var array<int, array<string, mixed>> */
    private $questions = [
        [
            "key" => "jobType",
            "label" => "希望職種",
            "options" => ["営業", "エンジニア", "マーケティング", "事務", "接客・販売", "未定"],
        ],
        [
            "key" => "workStyle",
            "label" => "希望の働き方",
            "options" => ["フルリモート", "ハイブリッド", "出社メイン", "こだわりなし"],
        ],
        [
            "key" => "priority",
            "label" => "転職で重視するポイント",
            "options" => ["年収アップ", "ワークライフバランス", "成長環境", "安定性", "福利厚生"],
        ],
        [
            "key" => "timing",
            "label" => "転職希望時期",
            "options" => ["すぐに", "1~3ヶ月以内", "半年以内", "情報収集段階"],
        ],
        [
            "key" => "location",
            "label" => "希望勤務地",
            "options" => ["東京", "関東圏", "大阪", "名古屋", "福岡", "全国可"],
        ],
    ];

    public static function instance(): Jobflow_Matching_Scheduler_Plugin
    {
        if (self::$instance === null) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    private function __construct()
    {
        register_activation_hook(__FILE__, [$this, "activate"]);
        add_shortcode("jobflow_app", [$this, "render_shortcode"]);
        add_action("rest_api_init", [$this, "register_rest_routes"]);
        add_action("admin_menu", [$this, "add_admin_menu"]);
    }

    public function activate(): void
    {
        $this->create_tables();
        $this->seed_companies();
        if (get_option(self::OPTION_LINE_URL) === false) {
            add_option(self::OPTION_LINE_URL, "https://line.me/R/ti/p/@example");
        }
    }

    private function create_tables(): void
    {
        global $wpdb;
        require_once ABSPATH . "wp-admin/includes/upgrade.php";
        $charset = $wpdb->get_charset_collate();

        $companies = $this->table("companies");
        $seekers = $this->table("seekers");
        $recommendations = $this->table("recommendations");
        $monthly = $this->table("monthly_capacity");
        $bookings = $this->table("bookings");

        dbDelta("
            CREATE TABLE {$companies} (
                id varchar(64) NOT NULL,
                name varchar(191) NOT NULL,
                industry varchar(191) NOT NULL,
                description text NOT NULL,
                strengths_json longtext NOT NULL,
                rep_name varchar(191) NOT NULL,
                rep_email varchar(191) NOT NULL,
                active tinyint(1) NOT NULL DEFAULT 1,
                PRIMARY KEY  (id)
            ) {$charset};
        ");

        dbDelta("
            CREATE TABLE {$seekers} (
                id varchar(64) NOT NULL,
                name varchar(191) NOT NULL,
                email varchar(191) NOT NULL,
                phone varchar(64) NOT NULL,
                answers_json longtext NOT NULL,
                created_at datetime NOT NULL,
                PRIMARY KEY  (id),
                KEY email_idx (email)
            ) {$charset};
        ");

        dbDelta("
            CREATE TABLE {$recommendations} (
                id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
                seeker_id varchar(64) NOT NULL,
                company_id varchar(64) NOT NULL,
                score int NOT NULL,
                created_at datetime NOT NULL,
                PRIMARY KEY  (id),
                KEY seeker_idx (seeker_id),
                KEY company_idx (company_id)
            ) {$charset};
        ");

        dbDelta("
            CREATE TABLE {$monthly} (
                company_id varchar(64) NOT NULL,
                year_month char(7) NOT NULL,
                booked_count int NOT NULL DEFAULT 0,
                updated_at datetime NOT NULL,
                PRIMARY KEY  (company_id, year_month)
            ) {$charset};
        ");

        dbDelta("
            CREATE TABLE {$bookings} (
                id varchar(64) NOT NULL,
                seeker_id varchar(64) NOT NULL,
                company_id varchar(64) NOT NULL,
                start_at datetime NOT NULL,
                end_at datetime NOT NULL,
                status varchar(20) NOT NULL,
                created_at datetime NOT NULL,
                answers_snapshot_json longtext NOT NULL,
                calendar_event_id varchar(191) DEFAULT NULL,
                PRIMARY KEY  (id),
                KEY company_time_idx (company_id, start_at, end_at),
                KEY seeker_idx (seeker_id)
            ) {$charset};
        ");
    }

    private function seed_companies(): void
    {
        global $wpdb;
        $companies_table = $this->table("companies");
        $count = (int) $wpdb->get_var("SELECT COUNT(1) FROM {$companies_table}");
        if ($count > 0) {
            return;
        }

        $seed = [
            [
                "id" => "comp-axis",
                "name" => "Axis Career Partners",
                "industry" => "総合人材",
                "description" => "未経験からハイクラスまで、幅広い職種に強い総合型エージェント。",
                "strengths" => ["営業", "事務", "未定", "関東圏", "安定性", "年収アップ"],
                "rep_name" => "山田 直人",
                "rep_email" => "axis@example.com",
            ],
            [
                "id" => "comp-tech",
                "name" => "Tech Bridge Agent",
                "industry" => "IT特化",
                "description" => "エンジニア・プロダクト職の転職支援に特化。リモート案件が豊富。",
                "strengths" => ["エンジニア", "フルリモート", "ハイブリッド", "成長環境", "全国可"],
                "rep_name" => "鈴木 悠斗",
                "rep_email" => "tech@example.com",
            ],
            [
                "id" => "comp-sales",
                "name" => "Sales Next",
                "industry" => "営業職特化",
                "description" => "法人営業・インサイドセールス案件に特化し、年収アップ提案が得意。",
                "strengths" => ["営業", "年収アップ", "東京", "関東圏", "すぐに"],
                "rep_name" => "小林 葵",
                "rep_email" => "sales@example.com",
            ],
            [
                "id" => "comp-marketing",
                "name" => "Growth Mark Careers",
                "industry" => "マーケティング特化",
                "description" => "デジタルマーケ職を中心に、成長企業とのマッチングを支援。",
                "strengths" => ["マーケティング", "成長環境", "ハイブリッド", "東京", "大阪"],
                "rep_name" => "高橋 美咲",
                "rep_email" => "marketing@example.com",
            ],
            [
                "id" => "comp-balance",
                "name" => "LifeShift Recruit",
                "industry" => "ワークライフ重視",
                "description" => "残業少なめ・福利厚生重視の求人を中心に取り扱い。",
                "strengths" => ["ワークライフバランス", "福利厚生", "安定性", "出社メイン", "名古屋", "福岡"],
                "rep_name" => "中村 海",
                "rep_email" => "lifeshift@example.com",
            ],
            [
                "id" => "comp-service",
                "name" => "Hospitality Works",
                "industry" => "接客・販売特化",
                "description" => "店舗運営・接客経験を活かせる求人紹介に強み。",
                "strengths" => ["接客・販売", "事務", "大阪", "福岡", "1~3ヶ月以内"],
                "rep_name" => "伊藤 さくら",
                "rep_email" => "service@example.com",
            ],
        ];

        foreach ($seed as $company) {
            $wpdb->insert(
                $companies_table,
                [
                    "id" => $company["id"],
                    "name" => $company["name"],
                    "industry" => $company["industry"],
                    "description" => $company["description"],
                    "strengths_json" => wp_json_encode($company["strengths"], JSON_UNESCAPED_UNICODE),
                    "rep_name" => $company["rep_name"],
                    "rep_email" => $company["rep_email"],
                    "active" => 1,
                ],
                ["%s", "%s", "%s", "%s", "%s", "%s", "%s", "%d"]
            );
        }
    }

    public function add_admin_menu(): void
    {
        add_menu_page(
            "Jobflow設定",
            "Jobflow設定",
            "manage_options",
            "jobflow-settings",
            [$this, "render_settings_page"],
            "dashicons-calendar-alt",
            58
        );
    }

    public function render_settings_page(): void
    {
        if (!current_user_can("manage_options")) {
            return;
        }

        if (
            $_SERVER["REQUEST_METHOD"] === "POST" &&
            isset($_POST["jobflow_line_url_nonce"]) &&
            wp_verify_nonce(sanitize_text_field(wp_unslash($_POST["jobflow_line_url_nonce"])), "jobflow_line_url_update")
        ) {
            $url = isset($_POST["line_registration_url"]) ? esc_url_raw(wp_unslash($_POST["line_registration_url"])) : "";
            if ($url === "") {
                $url = "https://line.me";
            }
            update_option(self::OPTION_LINE_URL, $url);
            echo '<div class="updated"><p>設定を保存しました。</p></div>';
        }

        $line_url = esc_url(get_option(self::OPTION_LINE_URL, "https://line.me/R/ti/p/@example"));
        ?>
        <div class="wrap">
            <h1>Jobflow 設定</h1>
            <p>ショートコード <code>[jobflow_app]</code> を固定ページに貼り付けてご利用ください。</p>
            <form method="post">
                <?php wp_nonce_field("jobflow_line_url_update", "jobflow_line_url_nonce"); ?>
                <table class="form-table" role="presentation">
                    <tbody>
                        <tr>
                            <th scope="row"><label for="line_registration_url">LINE登録URL</label></th>
                            <td><input name="line_registration_url" id="line_registration_url" class="regular-text" type="url" value="<?php echo esc_attr($line_url); ?>"></td>
                        </tr>
                    </tbody>
                </table>
                <?php submit_button("保存"); ?>
            </form>
        </div>
        <?php
    }

    public function register_rest_routes(): void
    {
        register_rest_route("jobflow/v1", "/questions", [
            "methods" => "GET",
            "callback" => [$this, "rest_questions"],
            "permission_callback" => "__return_true",
        ]);

        register_rest_route("jobflow/v1", "/public-config", [
            "methods" => "GET",
            "callback" => [$this, "rest_public_config"],
            "permission_callback" => "__return_true",
        ]);

        register_rest_route("jobflow/v1", "/recommendations", [
            "methods" => "POST",
            "callback" => [$this, "rest_recommendations"],
            "permission_callback" => "__return_true",
        ]);

        register_rest_route("jobflow/v1", "/companies/(?P<company_id>[A-Za-z0-9_-]+)/slots", [
            "methods" => "GET",
            "callback" => [$this, "rest_company_slots"],
            "permission_callback" => "__return_true",
        ]);

        register_rest_route("jobflow/v1", "/bookings", [
            "methods" => "POST",
            "callback" => [$this, "rest_bookings"],
            "permission_callback" => "__return_true",
        ]);

        register_rest_route("jobflow/v1", "/bookings/seeker/(?P<seeker_id>[A-Za-z0-9_-]+)", [
            "methods" => "GET",
            "callback" => [$this, "rest_bookings_by_seeker"],
            "permission_callback" => "__return_true",
        ]);

        register_rest_route("jobflow/v1", "/bookings/company/(?P<company_id>[A-Za-z0-9_-]+)", [
            "methods" => "GET",
            "callback" => [$this, "rest_bookings_by_company"],
            "permission_callback" => "__return_true",
        ]);
    }

    public function rest_questions(): WP_REST_Response
    {
        return new WP_REST_Response(["questions" => $this->questions], 200);
    }

    public function rest_public_config(): WP_REST_Response
    {
        return new WP_REST_Response([
            "lineRegistrationUrl" => apply_filters("jobflow_line_registration_url", get_option(self::OPTION_LINE_URL, "https://line.me")),
            "monthlyLimit" => self::MONTHLY_LIMIT,
        ], 200);
    }

    public function rest_recommendations(WP_REST_Request $request)
    {
        global $wpdb;
        $body = $request->get_json_params();
        $profile = isset($body["profile"]) && is_array($body["profile"]) ? $body["profile"] : [];
        $answers = isset($body["answers"]) && is_array($body["answers"]) ? $body["answers"] : [];

        $profile_valid = $this->validate_profile($profile);
        if (is_wp_error($profile_valid)) {
            return $profile_valid;
        }
        $answers_valid = $this->validate_answers($answers);
        if (is_wp_error($answers_valid)) {
            return $answers_valid;
        }

        $seeker_id = wp_generate_uuid4();
        $created_at = $this->now_mysql_utc();
        $seekers = $this->table("seekers");
        $wpdb->insert(
            $seekers,
            [
                "id" => $seeker_id,
                "name" => sanitize_text_field($profile["name"]),
                "email" => sanitize_email($profile["email"]),
                "phone" => sanitize_text_field($profile["phone"]),
                "answers_json" => wp_json_encode($answers, JSON_UNESCAPED_UNICODE),
                "created_at" => $created_at,
            ],
            ["%s", "%s", "%s", "%s", "%s", "%s"]
        );

        $companies_table = $this->table("companies");
        $monthly_table = $this->table("monthly_capacity");
        $target_month = wp_date("Y-m", null, wp_timezone());
        $sql = $wpdb->prepare(
            "
            SELECT c.*, COALESCE(m.booked_count, 0) AS booked_count
            FROM {$companies_table} c
            LEFT JOIN {$monthly_table} m
                ON m.company_id = c.id AND m.year_month = %s
            WHERE c.active = 1
            ",
            $target_month
        );
        $companies = $wpdb->get_results($sql, ARRAY_A);

        $scored = [];
        foreach ($companies as $company) {
            $booked_count = isset($company["booked_count"]) ? (int) $company["booked_count"] : 0;
            if ($booked_count >= self::MONTHLY_LIMIT) {
                continue;
            }
            $score = $this->score_company($company, $answers);
            $company["score"] = $score;
            $company["remainingSlots"] = self::MONTHLY_LIMIT - $booked_count;
            $scored[] = $company;
        }

        usort($scored, static function ($a, $b) {
            $score_diff = (int) $b["score"] - (int) $a["score"];
            if ($score_diff !== 0) {
                return $score_diff;
            }
            return (int) $b["remainingSlots"] - (int) $a["remainingSlots"];
        });

        $selected = array_slice($scored, 0, 3);
        $recommendations_table = $this->table("recommendations");
        foreach ($selected as $company) {
            $wpdb->insert(
                $recommendations_table,
                [
                    "seeker_id" => $seeker_id,
                    "company_id" => $company["id"],
                    "score" => (int) $company["score"],
                    "created_at" => $created_at,
                ],
                ["%s", "%s", "%d", "%s"]
            );
        }

        $response_companies = [];
        foreach ($selected as $company) {
            $response_companies[] = [
                "id" => $company["id"],
                "name" => $company["name"],
                "industry" => $company["industry"],
                "description" => $company["description"],
                "strengths" => $this->json_decode_array($company["strengths_json"]),
                "repName" => $company["rep_name"],
                "score" => (int) $company["score"],
                "remainingSlots" => (int) $company["remainingSlots"],
            ];
        }

        return new WP_REST_Response([
            "seekerId" => $seeker_id,
            "targetMonth" => $target_month,
            "recommendations" => $response_companies,
        ], 200);
    }

    public function rest_company_slots(WP_REST_Request $request)
    {
        global $wpdb;
        $company_id = sanitize_text_field((string) $request->get_param("company_id"));
        $start_date = sanitize_text_field((string) ($request->get_param("startDate") ?: wp_date("Y-m-d", null, wp_timezone())));
        $days = (int) $request->get_param("days");
        if ($days <= 0) {
            $days = 14;
        }
        if ($days > 30) {
            $days = 30;
        }

        $companies_table = $this->table("companies");
        $company = $wpdb->get_row(
            $wpdb->prepare("SELECT * FROM {$companies_table} WHERE id = %s AND active = 1", $company_id),
            ARRAY_A
        );
        if (!$company) {
            return new WP_Error("not_found", "会社が見つかりません。", ["status" => 404]);
        }

        $slots = $this->build_available_slots($company_id, $start_date, $days);
        if (is_wp_error($slots)) {
            return $slots;
        }

        return new WP_REST_Response([
            "companyId" => $company_id,
            "startDate" => $start_date,
            "days" => $days,
            "slots" => $slots,
        ], 200);
    }

    public function rest_bookings(WP_REST_Request $request)
    {
        global $wpdb;
        $body = $request->get_json_params();
        $seeker_id = sanitize_text_field((string) ($body["seekerId"] ?? ""));
        $company_id = sanitize_text_field((string) ($body["companyId"] ?? ""));
        $slot_start = sanitize_text_field((string) ($body["slotStart"] ?? ""));
        $return_to = isset($body["returnTo"]) ? sanitize_text_field((string) $body["returnTo"]) : "/";

        if ($seeker_id === "" || $company_id === "" || $slot_start === "") {
            return new WP_Error("invalid_params", "seekerId/companyId/slotStart を指定してください。", ["status" => 400]);
        }

        $tz = wp_timezone();
        try {
            $start = new DateTimeImmutable($slot_start);
        } catch (Exception $e) {
            return new WP_Error("invalid_date", "予約日時の形式が不正です。", ["status" => 400]);
        }
        $start_local = $start->setTimezone($tz);
        $min_start = new DateTimeImmutable("now", $tz);
        $min_start = $min_start->modify("+1 hour");
        if ($start_local < $min_start) {
            return new WP_Error("invalid_date", "予約は1時間後以降を指定してください。", ["status" => 400]);
        }
        $end = $start->modify("+" . self::SLOT_MINUTES . " minutes");
        $year_month = $start_local->format("Y-m");

        $seekers_table = $this->table("seekers");
        $companies_table = $this->table("companies");
        $bookings_table = $this->table("bookings");
        $monthly_table = $this->table("monthly_capacity");

        $seeker = $wpdb->get_row(
            $wpdb->prepare("SELECT * FROM {$seekers_table} WHERE id = %s", $seeker_id),
            ARRAY_A
        );
        if (!$seeker) {
            return new WP_Error("not_found", "求職者データが見つかりません。", ["status" => 400]);
        }
        $company = $wpdb->get_row(
            $wpdb->prepare("SELECT * FROM {$companies_table} WHERE id = %s AND active = 1", $company_id),
            ARRAY_A
        );
        if (!$company) {
            return new WP_Error("not_found", "会社データが見つかりません。", ["status" => 400]);
        }

        $is_google_free = apply_filters("jobflow_google_slot_is_free", true, $company, $start, $end);
        if (!$is_google_free) {
            return new WP_Error("slot_busy", "その枠は埋まっています。別の時間を選択してください。", ["status" => 400]);
        }

        $booking_id = wp_generate_uuid4();
        $created_at = $this->now_mysql_utc();
        $start_mysql = $start->setTimezone(new DateTimeZone("UTC"))->format("Y-m-d H:i:s");
        $end_mysql = $end->setTimezone(new DateTimeZone("UTC"))->format("Y-m-d H:i:s");

        $wpdb->query("START TRANSACTION");
        try {
            $capacity = $wpdb->get_var(
                $wpdb->prepare(
                    "SELECT booked_count FROM {$monthly_table} WHERE company_id = %s AND year_month = %s",
                    $company_id,
                    $year_month
                )
            );
            $booked_count = $capacity !== null ? (int) $capacity : 0;
            if ($booked_count >= self::MONTHLY_LIMIT) {
                throw new RuntimeException("この会社は今月の面談上限に達しています。");
            }

            $overlap = (int) $wpdb->get_var(
                $wpdb->prepare(
                    "
                    SELECT COUNT(1)
                    FROM {$bookings_table}
                    WHERE company_id = %s
                      AND status = 'confirmed'
                      AND start_at < %s
                      AND end_at > %s
                    ",
                    $company_id,
                    $end_mysql,
                    $start_mysql
                )
            );
            if ($overlap > 0) {
                throw new RuntimeException("その枠は他の予約と重複しています。");
            }

            $inserted = $wpdb->insert(
                $bookings_table,
                [
                    "id" => $booking_id,
                    "seeker_id" => $seeker_id,
                    "company_id" => $company_id,
                    "start_at" => $start_mysql,
                    "end_at" => $end_mysql,
                    "status" => "confirmed",
                    "created_at" => $created_at,
                    "answers_snapshot_json" => $seeker["answers_json"],
                ],
                ["%s", "%s", "%s", "%s", "%s", "%s", "%s", "%s"]
            );
            if ($inserted === false) {
                throw new RuntimeException("予約データの保存に失敗しました。");
            }

            $exists = $wpdb->get_var(
                $wpdb->prepare(
                    "SELECT booked_count FROM {$monthly_table} WHERE company_id = %s AND year_month = %s",
                    $company_id,
                    $year_month
                )
            );
            if ($exists === null) {
                $wpdb->insert(
                    $monthly_table,
                    [
                        "company_id" => $company_id,
                        "year_month" => $year_month,
                        "booked_count" => 1,
                        "updated_at" => $created_at,
                    ],
                    ["%s", "%s", "%d", "%s"]
                );
            } else {
                $wpdb->query(
                    $wpdb->prepare(
                        "
                        UPDATE {$monthly_table}
                        SET booked_count = booked_count + 1, updated_at = %s
                        WHERE company_id = %s AND year_month = %s
                        ",
                        $created_at,
                        $company_id,
                        $year_month
                    )
                );
            }

            $wpdb->query("COMMIT");
        } catch (Throwable $e) {
            $wpdb->query("ROLLBACK");
            return new WP_Error("booking_failed", $e->getMessage(), ["status" => 400]);
        }

        $booking = $wpdb->get_row(
            $wpdb->prepare(
                "
                SELECT b.*, c.name AS company_name, c.rep_name, c.rep_email,
                       s.name AS seeker_name, s.email AS seeker_email, s.phone AS seeker_phone, s.answers_json
                FROM {$bookings_table} b
                JOIN {$companies_table} c ON c.id = b.company_id
                JOIN {$seekers_table} s ON s.id = b.seeker_id
                WHERE b.id = %s
                ",
                $booking_id
            ),
            ARRAY_A
        );

        $calendar_event_id = apply_filters("jobflow_google_create_event", "", $booking);
        if (is_string($calendar_event_id) && $calendar_event_id !== "") {
            $wpdb->update(
                $bookings_table,
                ["calendar_event_id" => $calendar_event_id],
                ["id" => $booking_id],
                ["%s"],
                ["%s"]
            );
        }
        do_action("jobflow_append_to_sheet", $booking);
        $this->send_booking_mail($booking);

        if ($return_to === "" || $return_to[0] !== "/") {
            $return_to = "/";
        }
        $redirect_to = add_query_arg(
            [
                "jobflow_bookings" => "1",
                "seekerId" => $seeker_id,
            ],
            home_url($return_to)
        );

        return new WP_REST_Response([
            "bookingId" => $booking_id,
            "seekerId" => $seeker_id,
            "companyId" => $company_id,
            "companyName" => $booking["company_name"],
            "startAt" => $this->mysql_to_iso($booking["start_at"]),
            "endAt" => $this->mysql_to_iso($booking["end_at"]),
            "calendarEventId" => $calendar_event_id,
            "redirectTo" => $redirect_to,
        ], 200);
    }

    public function rest_bookings_by_seeker(WP_REST_Request $request)
    {
        global $wpdb;
        $seeker_id = sanitize_text_field((string) $request->get_param("seeker_id"));
        $seekers_table = $this->table("seekers");
        $bookings_table = $this->table("bookings");
        $companies_table = $this->table("companies");

        $seeker = $wpdb->get_row(
            $wpdb->prepare("SELECT * FROM {$seekers_table} WHERE id = %s", $seeker_id),
            ARRAY_A
        );
        if (!$seeker) {
            return new WP_Error("not_found", "求職者が見つかりません。", ["status" => 404]);
        }

        $bookings = $wpdb->get_results(
            $wpdb->prepare(
                "
                SELECT b.*, c.name AS company_name, c.rep_name, c.rep_email
                FROM {$bookings_table} b
                JOIN {$companies_table} c ON c.id = b.company_id
                WHERE b.seeker_id = %s
                ORDER BY b.start_at DESC
                ",
                $seeker_id
            ),
            ARRAY_A
        );

        foreach ($bookings as &$booking) {
            $booking["start_at"] = $this->mysql_to_iso($booking["start_at"]);
            $booking["end_at"] = $this->mysql_to_iso($booking["end_at"]);
        }

        return new WP_REST_Response([
            "seeker" => [
                "id" => $seeker["id"],
                "name" => $seeker["name"],
                "email" => $seeker["email"],
                "phone" => $seeker["phone"],
                "answers" => $this->json_decode_assoc($seeker["answers_json"]),
            ],
            "bookings" => $bookings,
        ], 200);
    }

    public function rest_bookings_by_company(WP_REST_Request $request)
    {
        global $wpdb;
        $company_id = sanitize_text_field((string) $request->get_param("company_id"));
        $companies_table = $this->table("companies");
        $bookings_table = $this->table("bookings");
        $seekers_table = $this->table("seekers");

        $company = $wpdb->get_row(
            $wpdb->prepare("SELECT * FROM {$companies_table} WHERE id = %s", $company_id),
            ARRAY_A
        );
        if (!$company) {
            return new WP_Error("not_found", "会社が見つかりません。", ["status" => 404]);
        }

        $bookings = $wpdb->get_results(
            $wpdb->prepare(
                "
                SELECT b.*, s.name AS seeker_name, s.email AS seeker_email, s.phone AS seeker_phone
                FROM {$bookings_table} b
                JOIN {$seekers_table} s ON s.id = b.seeker_id
                WHERE b.company_id = %s
                ORDER BY b.start_at DESC
                ",
                $company_id
            ),
            ARRAY_A
        );
        foreach ($bookings as &$booking) {
            $booking["start_at"] = $this->mysql_to_iso($booking["start_at"]);
            $booking["end_at"] = $this->mysql_to_iso($booking["end_at"]);
        }

        return new WP_REST_Response([
            "company" => ["id" => $company["id"], "name" => $company["name"]],
            "bookings" => $bookings,
        ], 200);
    }

    private function build_available_slots(string $company_id, string $start_date, int $days)
    {
        global $wpdb;
        $tz = wp_timezone();
        $companies_table = $this->table("companies");
        $bookings_table = $this->table("bookings");
        $monthly_table = $this->table("monthly_capacity");

        $start = DateTimeImmutable::createFromFormat("Y-m-d H:i:s", $start_date . " 00:00:00", $tz);
        if (!$start) {
            return new WP_Error("invalid_date", "startDate の形式が不正です。", ["status" => 400]);
        }
        $end = $start->modify("+{$days} days")->setTime(23, 59, 59);

        $start_utc = $start->setTimezone(new DateTimeZone("UTC"))->format("Y-m-d H:i:s");
        $end_utc = $end->setTimezone(new DateTimeZone("UTC"))->format("Y-m-d H:i:s");

        $local_busy_rows = $wpdb->get_results(
            $wpdb->prepare(
                "
                SELECT start_at, end_at
                FROM {$bookings_table}
                WHERE company_id = %s
                  AND status = 'confirmed'
                  AND start_at >= %s
                  AND start_at <= %s
                ",
                $company_id,
                $start_utc,
                $end_utc
            ),
            ARRAY_A
        );

        $busy_ranges = [];
        foreach ($local_busy_rows as $row) {
            $busy_ranges[] = [
                "start" => strtotime($row["start_at"] . " UTC"),
                "end" => strtotime($row["end_at"] . " UTC"),
            ];
        }

        $company = $wpdb->get_row(
            $wpdb->prepare("SELECT * FROM {$companies_table} WHERE id = %s", $company_id),
            ARRAY_A
        );
        $google_busy = apply_filters("jobflow_google_busy_ranges", [], $company, $start, $end);
        if (is_array($google_busy)) {
            foreach ($google_busy as $range) {
                if (!is_array($range) || !isset($range["start"], $range["end"])) {
                    continue;
                }
                $s = strtotime((string) $range["start"]);
                $e = strtotime((string) $range["end"]);
                if ($s && $e && $e > $s) {
                    $busy_ranges[] = ["start" => $s, "end" => $e];
                }
            }
        }

        $results = [];
        $now_local = new DateTimeImmutable("now", $tz);
        $min_local = $now_local->modify("+1 hour");

        for ($i = 0; $i < $days; $i++) {
            $day = $start->modify("+{$i} days");
            $day_num = (int) $day->format("N");
            if ($day_num === 6 || $day_num === 7) {
                continue;
            }

            $year_month = $day->format("Y-m");
            $booked_count = (int) $wpdb->get_var(
                $wpdb->prepare(
                    "SELECT booked_count FROM {$monthly_table} WHERE company_id = %s AND year_month = %s",
                    $company_id,
                    $year_month
                )
            );
            if ($booked_count >= self::MONTHLY_LIMIT) {
                continue;
            }

            $day_slots = [];
            foreach (self::SLOT_HOURS as $hour) {
                $slot_local = $day->setTime($hour, 0, 0);
                if ($slot_local < $min_local) {
                    continue;
                }
                $slot_end_local = $slot_local->modify("+" . self::SLOT_MINUTES . " minutes");

                $slot_start_utc_ts = $slot_local->setTimezone(new DateTimeZone("UTC"))->getTimestamp();
                $slot_end_utc_ts = $slot_end_local->setTimezone(new DateTimeZone("UTC"))->getTimestamp();

                if ($this->is_overlap($slot_start_utc_ts, $slot_end_utc_ts, $busy_ranges)) {
                    continue;
                }

                $day_slots[] = [
                    "startAt" => $slot_local->setTimezone(new DateTimeZone("UTC"))->format(DateTimeInterface::ATOM),
                    "endAt" => $slot_end_local->setTimezone(new DateTimeZone("UTC"))->format(DateTimeInterface::ATOM),
                    "label" => $slot_local->format("m/d") . "(" . wp_date("D", $slot_local->getTimestamp(), $tz) . ") " . $slot_local->format("H:i"),
                ];
            }

            if (!empty($day_slots)) {
                $results[] = [
                    "date" => $day->format("Y-m-d"),
                    "slots" => $day_slots,
                ];
            }
        }

        return $results;
    }

    private function score_company(array $company, array $answers): int
    {
        $strengths = $this->json_decode_array($company["strengths_json"]);
        $score = 0;
        foreach ($answers as $value) {
            if (!is_string($value) || $value === "") {
                continue;
            }
            if (in_array($value, $strengths, true)) {
                $score += 18;
            }
        }
        if (($answers["timing"] ?? "") === "すぐに") {
            $score += 4;
        }
        if (($answers["workStyle"] ?? "") === "フルリモート" && in_array("フルリモート", $strengths, true)) {
            $score += 6;
        }
        return $score;
    }

    private function validate_profile(array $profile)
    {
        foreach (["name", "email", "phone"] as $key) {
            if (!isset($profile[$key]) || trim((string) $profile[$key]) === "") {
                return new WP_Error("invalid_profile", "プロフィール項目 {$key} は必須です。", ["status" => 400]);
            }
        }
        return true;
    }

    private function validate_answers(array $answers)
    {
        foreach ($this->questions as $question) {
            $key = (string) $question["key"];
            if (!isset($answers[$key]) || trim((string) $answers[$key]) === "") {
                return new WP_Error("invalid_answers", $question["label"] . " を選択してください。", ["status" => 400]);
            }
        }
        return true;
    }

    private function json_decode_array(string $json): array
    {
        $decoded = json_decode($json, true);
        return is_array($decoded) ? array_values($decoded) : [];
    }

    private function json_decode_assoc(string $json): array
    {
        $decoded = json_decode($json, true);
        return is_array($decoded) ? $decoded : [];
    }

    private function send_booking_mail(array $booking): void
    {
        $should_send = apply_filters("jobflow_should_send_mail", true, $booking);
        if (!$should_send) {
            return;
        }
        $to = isset($booking["rep_email"]) ? sanitize_email($booking["rep_email"]) : "";
        if ($to === "") {
            return;
        }

        $subject = sprintf("【面談予約】%s 様 / %s", $booking["seeker_name"] ?? "", $booking["company_name"] ?? "");
        $start = isset($booking["start_at"]) ? $this->mysql_to_local_label($booking["start_at"]) : "";
        $end = isset($booking["end_at"]) ? $this->mysql_to_local_time($booking["end_at"]) : "";

        $message_lines = [
            ($booking["company_name"] ?? "貴社") . " ご担当者様",
            "",
            "以下の面談予約が入りました。",
            "求職者名: " . ($booking["seeker_name"] ?? ""),
            "メール: " . ($booking["seeker_email"] ?? ""),
            "電話: " . ($booking["seeker_phone"] ?? ""),
            "予約時間: " . $start . " - " . $end,
            "",
            "本メールは自動送信です。",
        ];

        $headers = [];
        if (!empty($booking["seeker_email"])) {
            $headers[] = "Cc: " . sanitize_email($booking["seeker_email"]);
        }
        wp_mail($to, $subject, implode("\n", $message_lines), $headers);
    }

    private function is_overlap(int $start_ts, int $end_ts, array $ranges): bool
    {
        foreach ($ranges as $range) {
            $range_start = isset($range["start"]) ? (int) $range["start"] : 0;
            $range_end = isset($range["end"]) ? (int) $range["end"] : 0;
            if ($start_ts < $range_end && $end_ts > $range_start) {
                return true;
            }
        }
        return false;
    }

    private function now_mysql_utc(): string
    {
        return gmdate("Y-m-d H:i:s");
    }

    private function mysql_to_iso(string $mysql_utc): string
    {
        $dt = new DateTimeImmutable($mysql_utc, new DateTimeZone("UTC"));
        return $dt->format(DateTimeInterface::ATOM);
    }

    private function mysql_to_local_label(string $mysql_utc): string
    {
        $tz = wp_timezone();
        $dt = new DateTimeImmutable($mysql_utc, new DateTimeZone("UTC"));
        return $dt->setTimezone($tz)->format("Y-m-d H:i");
    }

    private function mysql_to_local_time(string $mysql_utc): string
    {
        $tz = wp_timezone();
        $dt = new DateTimeImmutable($mysql_utc, new DateTimeZone("UTC"));
        return $dt->setTimezone($tz)->format("H:i");
    }

    private function table(string $suffix): string
    {
        global $wpdb;
        return $wpdb->prefix . "jobflow_" . $suffix;
    }

    public function render_shortcode(): string
    {
        $api_base = esc_url_raw(rtrim(rest_url("jobflow/v1"), "/"));
        $rest_nonce = wp_create_nonce("wp_rest");
        $booking_mode = isset($_GET["jobflow_bookings"], $_GET["seekerId"]) && $_GET["jobflow_bookings"] === "1";
        $seeker_id = $booking_mode ? sanitize_text_field(wp_unslash((string) $_GET["seekerId"])) : "";

        ob_start();
        ?>
        <div id="jobflow-app" data-api-base="<?php echo esc_attr($api_base); ?>" data-rest-nonce="<?php echo esc_attr($rest_nonce); ?>" data-booking-mode="<?php echo $booking_mode ? "1" : "0"; ?>" data-seeker-id="<?php echo esc_attr($seeker_id); ?>">
            <style>
                #jobflow-app{--c-text:#062832;--c-muted:#3d7a87;--c-border:#b2e8f0;--c-border-soft:#d9f4f8;--c-teal-50:#ecfeff;--c-teal-100:#cffafe;--c-teal-200:#a5f3fc;--c-teal-500:#06b6d4;--c-teal-700:#0e7490;--grad-main:linear-gradient(135deg,#06b6d4 0%,#0d9488 100%);--grad-soft:linear-gradient(135deg,#cffafe 0%,#ccfbf1 100%);--grad-card:linear-gradient(160deg,#fff 0%,#f0fdfa 100%);--grad-hero:linear-gradient(160deg,#e8fffe 0%,#f0faff 50%,#ecfffb 100%);--shadow-md:0 8px 24px rgba(6,40,50,.10);--radius-md:16px;--radius-lg:24px;--radius-pill:999px;font-family:'Noto Sans JP',sans-serif;background:var(--grad-hero);padding:24px 12px;border-radius:18px}
                #jobflow-app *{box-sizing:border-box}
                #jobflow-app .hidden{display:none!important}
                #jobflow-app .page{max-width:760px;margin:0 auto}
                #jobflow-app .card{background:rgba(255,255,255,.92);border-radius:var(--radius-lg);border:1px solid #fff;box-shadow:var(--shadow-md);padding:28px 22px;margin-bottom:16px}
                #jobflow-app .part-label{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;color:var(--c-teal-700);background:var(--c-teal-50);border:1px solid var(--c-teal-200);border-radius:var(--radius-pill);padding:3px 10px;margin-bottom:12px}
                #jobflow-app .section-title{font-size:22px;line-height:1.4;margin:0 0 18px;color:var(--c-text)}
                #jobflow-app .muted{font-size:12px;color:var(--c-muted)}
                #jobflow-app .field{margin-bottom:16px}
                #jobflow-app .field-label{font-size:14px;font-weight:700;margin:0 0 8px;color:var(--c-text)}
                #jobflow-app input[type=text],#jobflow-app input[type=tel],#jobflow-app input[type=email]{width:100%;padding:12px;border-radius:var(--radius-md);border:1.5px solid var(--c-border);font-size:14px}
                #jobflow-app .pill-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
                #jobflow-app .pill{border-radius:var(--radius-md);border:1.5px solid var(--c-border);padding:10px;font-size:13px;background:#fff;color:var(--c-muted);cursor:pointer}
                #jobflow-app .pill.is-active{background:var(--grad-soft);border-color:var(--c-teal-500);color:var(--c-teal-700);font-weight:700}
                #jobflow-app .btn-main,#jobflow-app .btn-sub,#jobflow-app .slot-btn,#jobflow-app .line-btn{border:none;border-radius:var(--radius-pill);cursor:pointer}
                #jobflow-app .btn-main{background:var(--grad-main);color:#fff;padding:12px 20px;font-weight:700}
                #jobflow-app .btn-main:disabled{opacity:.6;cursor:not-allowed}
                #jobflow-app .alert{display:none;padding:10px 12px;margin-bottom:12px;font-size:13px;border-radius:12px;border:1px solid #fecdd3;background:#fff1f2;color:#9f1239}
                #jobflow-app .alert.show{display:block}
                #jobflow-app .company-grid{display:grid;gap:12px}
                #jobflow-app .company-card{border:1px solid var(--c-border-soft);background:var(--grad-card);border-radius:14px;padding:14px}
                #jobflow-app .company-row{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}
                #jobflow-app .company-name{font-size:16px;font-weight:700;line-height:1.4;color:var(--c-text)}
                #jobflow-app .company-meta{font-size:12px;color:var(--c-muted)}
                #jobflow-app .badge{font-size:11px;padding:4px 10px;border-radius:999px;background:#e6fffa;color:#0f766e;border:1px solid #99f6e4;white-space:nowrap}
                #jobflow-app .strengths{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
                #jobflow-app .strength{font-size:11px;padding:4px 8px;border-radius:999px;background:#f0f9ff;color:#0369a1;border:1px solid #bae6fd}
                #jobflow-app .company-actions{margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
                #jobflow-app .btn-sub{border:1px solid var(--c-teal-200);background:#fff;color:var(--c-teal-700);padding:8px 12px;font-size:13px;font-weight:700}
                #jobflow-app .slots{display:none;margin-top:12px;padding-top:12px;border-top:1px dashed var(--c-border)}
                #jobflow-app .slots.show{display:block}
                #jobflow-app .slots-date{font-size:12px;font-weight:700;color:var(--c-teal-700);margin-bottom:6px}
                #jobflow-app .slot-list{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
                #jobflow-app .slot-btn{padding:6px 11px;font-size:12px;border:1px solid #99d5e0;background:#fff}
                #jobflow-app .book-list{display:grid;gap:10px}
                #jobflow-app .book-item{padding:12px;border:1px solid #d8f4f8;background:#f8feff;border-radius:12px}
                #jobflow-app .book-item h3{margin:0 0 6px;font-size:16px}
                #jobflow-app .line-btn{display:inline-flex;align-items:center;justify-content:center;text-decoration:none;margin-top:16px;background:var(--grad-main);color:#fff;padding:11px 20px;font-weight:700}
                @media(max-width:640px){#jobflow-app .card{padding:20px 14px}#jobflow-app .pill-grid{grid-template-columns:1fr}#jobflow-app .company-row{flex-direction:column}}
            </style>

            <div class="page">
                <section class="card" id="jobflowQuestionCard">
                    <span class="part-label">求職者ヒアリング</span>
                    <h2 class="section-title">まずは転職条件を教えてください</h2>
                    <div class="alert" id="jobflowFormAlert"></div>
                    <form id="jobflowQuestionForm">
                        <div class="field">
                            <p class="field-label">お名前 *</p>
                            <input id="jobflowName" type="text" required>
                        </div>
                        <div class="field">
                            <p class="field-label">メールアドレス *</p>
                            <input id="jobflowEmail" type="email" required>
                        </div>
                        <div class="field">
                            <p class="field-label">電話番号 *</p>
                            <input id="jobflowPhone" type="tel" required>
                        </div>
                        <div id="jobflowQuestionFields"></div>
                        <button class="btn-main" id="jobflowRecommendBtn" type="submit">3社を提案してもらう</button>
                    </form>
                </section>

                <section class="card hidden" id="jobflowResultCard">
                    <span class="part-label">会社提案 & 日程調整</span>
                    <h2 class="section-title">あなたにおすすめの3社です</h2>
                    <p class="muted">各社の「日程を調整する」ボタンから空き枠を選択してください。</p>
                    <div class="alert" id="jobflowBookingAlert"></div>
                    <div class="company-grid" id="jobflowCompanyGrid"></div>
                </section>

                <section class="card hidden" id="jobflowBookingCard">
                    <span class="part-label">予約完了</span>
                    <h2 class="section-title">面談予約が完了しました</h2>
                    <div class="alert" id="jobflowCompleteError"></div>
                    <h3>あなたの予約一覧</h3>
                    <div class="book-list" id="jobflowBookingList"></div>
                    <h3 style="margin-top:16px">回答内容</h3>
                    <div class="book-item" id="jobflowAnswerList"></div>
                    <a class="line-btn" id="jobflowLineButton" href="#" target="_blank" rel="noopener noreferrer">無料LINE登録へ進む</a>
                </section>
            </div>
        </div>
        <script>
            (() => {
                const root = document.getElementById("jobflow-app");
                if (!root) return;
                const apiBase = root.dataset.apiBase || "";
                const restNonce = root.dataset.restNonce || "";
                const isBookingMode = root.dataset.bookingMode === "1";
                const bookingSeekerId = root.dataset.seekerId || "";
                const state = { questions: [], answers: {}, seekerId: null, recommendations: [] };

                const questionCard = document.getElementById("jobflowQuestionCard");
                const resultCard = document.getElementById("jobflowResultCard");
                const bookingCard = document.getElementById("jobflowBookingCard");
                const form = document.getElementById("jobflowQuestionForm");
                const fields = document.getElementById("jobflowQuestionFields");
                const recommendBtn = document.getElementById("jobflowRecommendBtn");
                const companyGrid = document.getElementById("jobflowCompanyGrid");
                const formAlert = document.getElementById("jobflowFormAlert");
                const bookingAlert = document.getElementById("jobflowBookingAlert");
                const completeError = document.getElementById("jobflowCompleteError");
                const bookingList = document.getElementById("jobflowBookingList");
                const answerList = document.getElementById("jobflowAnswerList");
                const lineBtn = document.getElementById("jobflowLineButton");

                const headers = { "Content-Type": "application/json", "X-WP-Nonce": restNonce };

                if (isBookingMode && bookingSeekerId) {
                    questionCard.classList.add("hidden");
                    resultCard.classList.add("hidden");
                    bookingCard.classList.remove("hidden");
                    loadBookingComplete(bookingSeekerId).catch((e) => showAlert(completeError, e.message || "表示に失敗しました。"));
                    return;
                }

                initialize().catch((e) => showAlert(formAlert, e.message || "初期化に失敗しました。"));
                form.addEventListener("submit", onSubmit);

                async function initialize() {
                    const data = await apiGet("/questions");
                    state.questions = data.questions || [];
                    renderQuestionFields();
                }

                function renderQuestionFields() {
                    fields.innerHTML = "";
                    state.questions.forEach((q) => {
                        const field = document.createElement("div");
                        field.className = "field";
                        field.innerHTML = `<p class="field-label">${esc(q.label)} *</p><div class="pill-grid" data-key="${esc(q.key)}"></div>`;
                        const grid = field.querySelector(".pill-grid");
                        (q.options || []).forEach((option) => {
                            const btn = document.createElement("button");
                            btn.type = "button";
                            btn.className = "pill";
                            btn.textContent = option;
                            btn.dataset.value = option;
                            btn.addEventListener("click", () => {
                                state.answers[q.key] = option;
                                Array.from(grid.querySelectorAll(".pill")).forEach((pill) => {
                                    pill.classList.toggle("is-active", pill.dataset.value === option);
                                });
                            });
                            grid.appendChild(btn);
                        });
                        fields.appendChild(field);
                    });
                }

                async function onSubmit(event) {
                    event.preventDefault();
                    hideAlert(formAlert);
                    const profile = {
                        name: document.getElementById("jobflowName").value.trim(),
                        email: document.getElementById("jobflowEmail").value.trim(),
                        phone: document.getElementById("jobflowPhone").value.trim(),
                    };
                    if (!profile.name || !profile.email || !profile.phone) {
                        showAlert(formAlert, "お名前・メール・電話番号は必須です。");
                        return;
                    }
                    for (const q of state.questions) {
                        if (!state.answers[q.key]) {
                            showAlert(formAlert, `${q.label}を選択してください。`);
                            return;
                        }
                    }
                    recommendBtn.disabled = true;
                    recommendBtn.textContent = "提案を作成中...";
                    try {
                        const data = await apiPost("/recommendations", { profile, answers: state.answers });
                        state.seekerId = data.seekerId;
                        state.recommendations = data.recommendations || [];
                        renderRecommendations();
                        resultCard.classList.remove("hidden");
                        resultCard.scrollIntoView({ behavior: "smooth", block: "start" });
                    } catch (e) {
                        showAlert(formAlert, e.message || "提案取得に失敗しました。");
                    } finally {
                        recommendBtn.disabled = false;
                        recommendBtn.textContent = "3社を提案してもらう";
                    }
                }

                function renderRecommendations() {
                    companyGrid.innerHTML = "";
                    if (!state.recommendations.length) {
                        companyGrid.innerHTML = `<p class="muted">提案可能な会社がありません。</p>`;
                        return;
                    }
                    state.recommendations.forEach((company) => {
                        const card = document.createElement("article");
                        card.className = "company-card";
                        card.innerHTML = `
                            <div class="company-row">
                                <div>
                                    <p class="company-name">${esc(company.name)}</p>
                                    <p class="company-meta">${esc(company.industry)} / 担当: ${esc(company.repName)}</p>
                                </div>
                                <span class="badge">今月残り ${Number(company.remainingSlots || 0)} 枠</span>
                            </div>
                            <p class="company-meta" style="margin-top:6px">${esc(company.description || "")}</p>
                            <div class="strengths">${(company.strengths || []).map((s) => `<span class="strength">${esc(s)}</span>`).join("")}</div>
                            <div class="company-actions">
                                <button class="btn-sub" type="button" data-action="toggle">日程を調整する</button>
                                <span class="muted" data-role="status">未選択</span>
                            </div>
                            <div class="slots" data-role="slots"><p class="muted">空き枠を読み込んでください。</p></div>
                        `;
                        const slots = card.querySelector('[data-role="slots"]');
                        const status = card.querySelector('[data-role="status"]');
                        const btn = card.querySelector('[data-action="toggle"]');
                        let loaded = false;
                        btn.addEventListener("click", async () => {
                            slots.classList.toggle("show");
                            if (!slots.classList.contains("show")) return;
                            if (loaded) return;
                            slots.innerHTML = `<p class="muted">空き枠を読み込み中...</p>`;
                            try {
                                const data = await apiGet(`/companies/${encodeURIComponent(company.id)}/slots`);
                                renderSlots(slots, data.slots || [], async (startAt) => {
                                    await bookSlot(company.id, startAt, status);
                                });
                                loaded = true;
                            } catch (e) {
                                slots.innerHTML = `<p class="muted">空き枠の取得に失敗しました。</p>`;
                            }
                        });
                        companyGrid.appendChild(card);
                    });
                }

                function renderSlots(container, days, onSelect) {
                    if (!days.length) {
                        container.innerHTML = `<p class="muted">空き枠がありません。</p>`;
                        return;
                    }
                    container.innerHTML = days.map((day) => `
                        <div>
                            <p class="slots-date">${esc(day.date)}</p>
                            <div class="slot-list">
                                ${(day.slots || []).map((slot) => `<button class="slot-btn" type="button" data-start="${esc(slot.startAt)}">${esc(slot.label)}</button>`).join("")}
                            </div>
                        </div>
                    `).join("");
                    Array.from(container.querySelectorAll(".slot-btn")).forEach((btn) => {
                        btn.addEventListener("click", () => onSelect(btn.dataset.start));
                    });
                }

                async function bookSlot(companyId, slotStart, statusEl) {
                    hideAlert(bookingAlert);
                    statusEl.textContent = "予約処理中...";
                    try {
                        const data = await apiPost("/bookings", {
                            seekerId: state.seekerId,
                            companyId,
                            slotStart,
                            returnTo: window.location.pathname
                        });
                        statusEl.textContent = `予約完了: ${formatDateTime(data.startAt)}`;
                        window.location.href = data.redirectTo;
                    } catch (e) {
                        statusEl.textContent = "未選択";
                        showAlert(bookingAlert, e.message || "予約に失敗しました。");
                    }
                }

                async function loadBookingComplete(seekerId) {
                    const [bookingData, configData] = await Promise.all([
                        apiGet(`/bookings/seeker/${encodeURIComponent(seekerId)}`),
                        apiGet("/public-config"),
                    ]);
                    const bookings = bookingData.bookings || [];
                    if (!bookings.length) {
                        bookingList.innerHTML = `<p class="muted">予約データがありません。</p>`;
                    } else {
                        bookingList.innerHTML = bookings.map((b) => `
                            <article class="book-item">
                                <h3>${esc(b.company_name)}</h3>
                                <p class="muted">予約完了時間: ${esc(formatDateTime(b.start_at))} - ${esc(formatTime(b.end_at))}</p>
                                <p class="muted">担当者: ${esc(b.rep_name)} (${esc(b.rep_email)})</p>
                            </article>
                        `).join("");
                    }
                    const answers = bookingData.seeker && bookingData.seeker.answers ? bookingData.seeker.answers : {};
                    const entries = Object.entries(answers);
                    if (!entries.length) {
                        answerList.innerHTML = `<p class="muted">回答情報がありません。</p>`;
                    } else {
                        answerList.innerHTML = entries.map(([k, v]) => `<p><strong>${esc(k)}</strong>: ${esc(v)}</p>`).join("");
                    }
                    lineBtn.href = (configData && configData.lineRegistrationUrl) ? configData.lineRegistrationUrl : "https://line.me";
                }

                async function apiGet(path) {
                    const response = await fetch(`${apiBase}${path}`, { headers: { "X-WP-Nonce": restNonce } });
                    const data = await response.json();
                    if (!response.ok) throw new Error(data.message || data.error || "APIエラー");
                    return data;
                }

                async function apiPost(path, body) {
                    const response = await fetch(`${apiBase}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
                    const data = await response.json();
                    if (!response.ok) throw new Error(data.message || data.error || "APIエラー");
                    return data;
                }

                function showAlert(target, message) {
                    target.classList.add("show");
                    target.textContent = message;
                }
                function hideAlert(target) {
                    target.classList.remove("show");
                    target.textContent = "";
                }
                function formatDateTime(iso) {
                    const d = new Date(iso);
                    return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
                }
                function formatTime(iso) {
                    const d = new Date(iso);
                    return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
                }
                function esc(val) {
                    return String(val ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
                }
            })();
        </script>
        <?php
        return (string) ob_get_clean();
    }
}

Jobflow_Matching_Scheduler_Plugin::instance();
