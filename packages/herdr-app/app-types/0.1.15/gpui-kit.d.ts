declare module "gpui-kit" {
  export type Length = number | import("gpui-shell").LengthString | "auto";
  export type DefiniteLength = number | import("gpui-shell").LengthString;
  export type AbsoluteLength = number | `${number}px` | `${number}rem`;
  export type Axis = "horizontal" | "vertical";
  export type HostValue =
    | null
    | boolean
    | number
    | string
    | HostValue[]
    | { [key: string]: HostValue };
  export type Color = `#${string}`;
  export type Role =
    | "unknown"
    | "text_run"
    | "cell"
    | "label"
    | "image"
    | "link"
    | "row"
    | "list_item"
    | "list_marker"
    | "tree_item"
    | "list_box_option"
    | "menu_item"
    | "menu_list_option"
    | "paragraph"
    | "check_box"
    | "radio_button"
    | "text_input"
    | "button"
    | "default_button"
    | "pane"
    | "row_header"
    | "column_header"
    | "row_group"
    | "list"
    | "table"
    | "layout_table_cell"
    | "layout_table_row"
    | "layout_table"
    | "switch"
    | "menu"
    | "multiline_text_input"
    | "search_input"
    | "date_input"
    | "date_time_input"
    | "week_input"
    | "month_input"
    | "time_input"
    | "email_input"
    | "number_input"
    | "password_input"
    | "phone_number_input"
    | "url_input"
    | "abbr"
    | "alert"
    | "alert_dialog"
    | "application"
    | "article"
    | "audio"
    | "banner"
    | "blockquote"
    | "canvas"
    | "caption"
    | "caret"
    | "code"
    | "color_well"
    | "combo_box"
    | "editable_combo_box"
    | "complementary"
    | "comment"
    | "content_deletion"
    | "content_insertion"
    | "content_info"
    | "definition"
    | "description_list"
    | "details"
    | "dialog"
    | "disclosure_triangle"
    | "document"
    | "embedded_object"
    | "emphasis"
    | "feed"
    | "figure_caption"
    | "figure"
    | "footer"
    | "form"
    | "grid"
    | "grid_cell"
    | "group"
    | "header"
    | "heading"
    | "iframe"
    | "iframe_presentational"
    | "ime_candidate"
    | "keyboard"
    | "legend"
    | "line_break"
    | "list_box"
    | "log"
    | "main"
    | "mark"
    | "marquee"
    | "math"
    | "menu_bar"
    | "menu_item_check_box"
    | "menu_item_radio"
    | "menu_list_popup"
    | "meter"
    | "navigation"
    | "note"
    | "plugin_object"
    | "progress_indicator"
    | "radio_group"
    | "region"
    | "root_web_area"
    | "ruby"
    | "ruby_annotation"
    | "scroll_bar"
    | "scroll_view"
    | "search"
    | "section"
    | "section_footer"
    | "section_header"
    | "slider"
    | "spin_button"
    | "splitter"
    | "status"
    | "strong"
    | "suggestion"
    | "svg_root"
    | "tab"
    | "tab_list"
    | "tab_panel"
    | "term"
    | "time"
    | "timer"
    | "title_bar"
    | "toolbar"
    | "tooltip"
    | "tree"
    | "tree_grid"
    | "video"
    | "web_view"
    | "window"
    | "pdf_actionable_highlight"
    | "pdf_root"
    | "graphics_document"
    | "graphics_object"
    | "graphics_symbol"
    | "doc_abstract"
    | "doc_acknowledgements"
    | "doc_afterword"
    | "doc_appendix"
    | "doc_back_link"
    | "doc_biblio_entry"
    | "doc_bibliography"
    | "doc_biblio_ref"
    | "doc_chapter"
    | "doc_colophon"
    | "doc_conclusion"
    | "doc_cover"
    | "doc_credit"
    | "doc_credits"
    | "doc_dedication"
    | "doc_endnote"
    | "doc_endnotes"
    | "doc_epigraph"
    | "doc_epilogue"
    | "doc_errata"
    | "doc_example"
    | "doc_footnote"
    | "doc_foreword"
    | "doc_glossary"
    | "doc_gloss_ref"
    | "doc_index"
    | "doc_introduction"
    | "doc_note_ref"
    | "doc_notice"
    | "doc_page_break"
    | "doc_page_footer"
    | "doc_page_header"
    | "doc_page_list"
    | "doc_part"
    | "doc_preface"
    | "doc_prologue"
    | "doc_pullquote"
    | "doc_qna"
    | "doc_subtitle"
    | "doc_tip"
    | "doc_toc"
    | "list_grid"
    | "terminal"
    ;
  export type Anchor =
    | "top_left"
    | "top_right"
    | "bottom_left"
    | "bottom_right"
    | "top_center"
    | "bottom_center"
    | "left_center"
    | "right_center"
    ;
  export type MouseButton = "left" | "right" | "middle";
  export interface Context {
    notify(target?: Entity): void;
    bind_keys(bindings: KeyBinding[]): number;
    stop_propagation(): void;
    propagate(): void;
    phase(): import("gpui-shell").ScopePhase;
    theme(): import("gpui-base").Theme;
    open_url(url: string): void;
    read_from_clipboard(): string | undefined;
    write_to_clipboard(text: string): void;
    focus_handle(): FocusHandle;
    new(Class: ViewClass, props?: import("gpui-shell").Props): Entity;
    spawn(body: (cx: AsyncContext) => unknown, opts?: import("gpui-shell").TaskOptions): Task;
    sleep(ms?: number): Promise<void>;
    readonly timer: Timer;
  }
  export interface AsyncContext extends Context {}
  export interface Modifiers {
    shift: boolean;
    control: boolean;
    alt: boolean;
    platform: boolean;
    function: boolean;
  }
  export interface Capslock {
    on: boolean;
  }
  export interface ModifiersChangedEvent {
    modifiers: Modifiers;
    capslock: Capslock;
  }
  export interface ClickEvent {
    click_count: number;
    modifiers: Modifiers;
  }
  export interface KeyEvent {
    key: string;
    keystroke: string;
    key_char?: string;
    modifiers: Modifiers;
    is_held?: boolean;
  }
  export interface Point { x: number; y: number; }
  export interface Size { width: number; height: number; }
  export interface MouseMoveEvent {
    position: Point;
    local_position: Point;
    bounds: import("gpui-shell").ElementBounds;
    modifiers: Modifiers;
  }
  export interface MouseButtonEvent {
    button: MouseButton;
    click_count: number;
    position: Point;
    local_position?: Point;
    bounds?: import("gpui-shell").ElementBounds;
    modifiers: Modifiers;
  }
  export interface ActionEvent {
    action: string;
  }
  export interface KeyBinding {
    keystroke: string;
    action: string;
    context?: string;
  }
  export interface ScrollWheelEvent {
    delta: Point;
    delta_lines?: Point;
    touch_phase: "started" | "moved" | "ended" | "cancelled";
    position: Point;
    local_position?: Point;
    bounds?: import("gpui-shell").ElementBounds;
    modifiers: Modifiers;
  }
  export abstract class View {
    constructor(props?: import("gpui-shell").Props);
    init?(props: import("gpui-shell").Props | undefined, cx: AsyncContext): void;
    update?(props: import("gpui-shell").Props | undefined): void;
    close?(cx: AsyncContext): void | Promise<void>;
    abstract render(cx: Context): Element | Entity | string;
  }
  export type ViewClass = new (props?: import("gpui-shell").Props) => View;
  export interface Entity {
    set_props(props?: import("gpui-shell").Props): void;
    release(): boolean;
  }
  export type Element = NativeElement;
  export interface NativeElement {
    map<Self extends Element, T>(this: Self, transform: (element: Self) => T): T;
    child<Self extends Element>(this: Self, child: Element | Entity | string | number | boolean): Self;
    children<Self extends Element>(this: Self, children: Iterable<Element | Entity | string | number | boolean>): Self;
    content<Self extends Element>(this: Self, element: Element): Self;
    image<Self extends Element>(this: Self, element: Element): Self;
    fallback<Self extends Element>(this: Self, element: Element): Self;
    header<Self extends Element>(this: Self, element: Element): Self;
    footer<Self extends Element>(this: Self, element: Element): Self;
    panel<Self extends Element>(this: Self, element: Element): Self;
    trigger<Self extends Element>(this: Self, element: Element): Self;
    input<Self extends Element>(this: Self, element: Element): Self;
    decrement_button<Self extends Element>(this: Self, element: Element): Self;
    increment_button<Self extends Element>(this: Self, element: Element): Self;
    controls_right<Self extends Element>(this: Self): Self;
    when<Self extends Element>(this: Self, condition: unknown, branch: (el: Self) => Self): Self;
    on_click<Self extends Element>(this: Self, handler: (event: ClickEvent, cx: Context) => void): Self;
    on_mouse_move<Self extends Element>(this: Self, handler: (event: MouseMoveEvent, cx: Context) => void): Self;
    on_size_change<Self extends Element>(this: Self, handler: (size: { width: number; height: number }, cx: Context) => void): Self;
    on_hover<Self extends Element>(this: Self, handler: (hovered: boolean, cx: Context) => void): Self;
    on_key_down<Self extends Element>(this: Self, handler: (event: KeyEvent, cx: Context) => void): Self;
    on_key_up<Self extends Element>(this: Self, handler: (event: KeyEvent, cx: Context) => void): Self;
    on_modifiers_changed<Self extends Element>(this: Self,
      handler: (event: ModifiersChangedEvent, cx: Context) => void,
    ): Self;
    on_mouse_down<Self extends Element>(this: Self,
      button: MouseButton,
      handler: (event: MouseButtonEvent, cx: Context) => void,
    ): Self;
    on_mouse_up<Self extends Element>(this: Self,
      button: MouseButton,
      handler: (event: MouseButtonEvent, cx: Context) => void,
    ): Self;
    on_mouse_down_out<Self extends Element>(this: Self, handler: (event: MouseButtonEvent, cx: Context) => void): Self;
    on_drop<Self extends Element>(this: Self, handler: (event: { paths: string[] }, cx: Context) => void): Self;
    on_scroll_wheel<Self extends Element>(this: Self, handler: (event: ScrollWheelEvent, cx: Context) => void): Self;
    on_action<Self extends Element>(this: Self, action: string, handler: (event: ActionEvent, cx: Context) => void): Self;
    key_context<Self extends Element>(this: Self, context: string): Self;
    aria_level<Self extends Element>(this: Self, level: number): Self;
    keep_mounted<Self extends Element>(this: Self, value?: boolean): Self;
    on_item_click<Self extends Element>(this: Self, handler: (key: string, cx: Context) => void): Self;
    on_item_secondary_click<Self extends Element>(this: Self,
      handler: (key: string, event: MouseButtonEvent, cx: Context) => void,
    ): Self;
    on_change<Self extends Element>(this: Self, handler: (checked: boolean, cx: Context) => void): Self;
    on_step<Self extends Element>(this: Self, handler: (action: "increment" | "decrement", cx: Context) => void): Self;
    on_open_change<Self extends Element>(this: Self, handler: (open: boolean, cx: Context) => void): Self;
    on_confirm<Self extends Element>(this: Self, handler: (event: {}, cx: Context) => void): Self;
    on_dismiss<Self extends Element>(this: Self, handler: (event: {}, cx: Context) => void): Self;
    tooltip<Self extends Element>(this: Self, text: string): Self;
    disabled<Self extends Element>(this: Self, value: boolean): Self;
    selected<Self extends Element>(this: Self, value: boolean): Self;
    set_position<Self extends Element>(this: Self, position: number, size: number): Self;
    checked<Self extends Element>(this: Self, value: boolean): Self;
    pressed<Self extends Element>(this: Self, value: boolean): Self;
    value<Self extends Element>(this: Self, percent: number): Self;
    indeterminate<Self extends Element>(this: Self, value: boolean): Self;
    accessibility_label<Self extends Element>(this: Self, description: string): Self;
    role<Self extends Element>(this: Self, name: Role): Self;
    aria_selected<Self extends Element>(this: Self, value: boolean): Self;
    aria_active_descendant<Self extends Element>(this: Self): Self;
    track_focus<Self extends Element>(this: Self, handle: FocusHandle): Self;
    track_scroll<Self extends Element>(this: Self, handle: import("gpui-base").VirtualListScrollHandle | import("gpui-base").ScrollHandle): Self;
    with_item_to_measure_index<Self extends Element>(this: Self, index: number): Self;
    content_focus_handle<Self extends Element>(this: Self, handle: FocusHandle): Self;
    tab_index<Self extends Element>(this: Self, index: number): Self;
    tab_stop<Self extends Element>(this: Self, value: boolean): Self;
    href<Self extends Element>(this: Self, url: string): Self;
    id<Self extends Element>(this: Self, name: string): Self;
    overflow_scroll<Self extends Element>(this: Self): Self;
    overflow_x_scroll<Self extends Element>(this: Self): Self;
    overflow_y_scroll<Self extends Element>(this: Self): Self;
    overflow_scrollbar<Self extends Element>(this: Self): Self;
    overflow_x_scrollbar<Self extends Element>(this: Self): Self;
    overflow_y_scrollbar<Self extends Element>(this: Self): Self;
    mode<Self extends Element>(this: Self, value: import("gpui-base").ScrollbarMode): Self;
    scroll_size<Self extends Element>(this: Self, width: number, height: number): Self;
    viewport_from_layout<Self extends Element>(this: Self): Self;
    size_range<Self extends Element>(this: Self, min: number, max?: number): Self;
    on_resize<Self extends Element>(this: Self, handler: (sizes: number[], cx: Context) => void): Self;
    axis<Self extends Element>(this: Self, value: Axis): Self;
    row_count<Self extends Element>(this: Self, count: number): Self;
    column_count<Self extends Element>(this: Self, count: number): Self;
    open<Self extends Element>(this: Self, value: boolean): Self;
    default_open<Self extends Element>(this: Self, value: boolean): Self;
    overlay_closable<Self extends Element>(this: Self, value: boolean): Self;
    anchor<Self extends Element>(this: Self, value: Anchor): Self;
    frame_budget<Self extends Element>(this: Self, milliseconds: number): Self;
    mouse_button<Self extends Element>(this: Self, value: MouseButton): Self;
    open_delay<Self extends Element>(this: Self, ms: number): Self;
    close_delay<Self extends Element>(this: Self, ms: number): Self;
    transition<Self extends Element>(this: Self, property: import("gpui-shell").MotionProperty, policy: number | import("gpui-shell").TransitionPolicy): Self;
    spring<Self extends Element>(this: Self, property: import("gpui-shell").MotionProperty, policy?: import("gpui-shell").SpringPolicy): Self;
    frames<Self extends Element>(this: Self, list: string[], ms: number): Self;
    loop<Self extends Element>(this: Self, property: import("gpui-shell").MotionProperty, policy: import("gpui-shell").LoopPolicy): Self;
    spin<Self extends Element>(this: Self, ms: number): Self;
    start<Self extends Element>(this: Self, value: boolean): Self;
    range_style<Self extends Element>(this: Self, declare: (el: NativeElement) => NativeElement | void): Self;
    cell_style<Self extends Element>(this: Self, declare: (el: NativeElement) => NativeElement | void): Self;
    cell_active_style<Self extends Element>(this: Self, declare: (el: NativeElement) => NativeElement | void): Self;
    caret_style<Self extends Element>(this: Self, declare: (el: NativeElement) => NativeElement | void): Self;
    hover<Self extends Element>(this: Self, declare: (el: NativeElement) => NativeElement | void): Self;
    active<Self extends Element>(this: Self, declare: (el: NativeElement) => NativeElement | void): Self;
    focus<Self extends Element>(this: Self, declare: (el: NativeElement) => NativeElement | void): Self;
    select_tab<Self extends Element>(this: Self, group: import("gpui-base").DockGroup, index: number): Self;
    close_panel<Self extends Element>(this: Self, group: import("gpui-base").DockGroup, panel: number): Self;
    toggle_zoom<Self extends Element>(this: Self, group: import("gpui-base").DockGroup): Self;
    drag_tab<Self extends Element>(this: Self, group: import("gpui-base").DockGroup, index: number): Self;
    drop_tab<Self extends Element>(this: Self, group: import("gpui-base").DockGroup, index?: number): Self;
    toggle_dock<Self extends Element>(this: Self, dock: import("gpui-base").DockRegion): Self;
    resize_dock<Self extends Element>(this: Self, dock: import("gpui-base").DockRegion): Self;
    token(render: (token: import("gpui-base").InlineTokenContext, cx: Context) => Element | null): this;
    on_token_click(listener: (event: import("gpui-base").InlineTokenClickEvent, cx: Context) => void): this;
    on_token_hover(listener: (event: import("gpui-base").InlineTokenHoverEvent, cx: Context) => void): this;
    bg<Self extends Element>(this: Self, value: Color): Self;
    border<Self extends Element>(this: Self, value: AbsoluteLength): Self;
    border_b<Self extends Element>(this: Self, value: AbsoluteLength): Self;
    border_color<Self extends Element>(this: Self, value: Color): Self;
    border_l<Self extends Element>(this: Self, value: AbsoluteLength): Self;
    border_r<Self extends Element>(this: Self, value: AbsoluteLength): Self;
    border_t<Self extends Element>(this: Self, value: AbsoluteLength): Self;
    border_x<Self extends Element>(this: Self, value: AbsoluteLength): Self;
    border_y<Self extends Element>(this: Self, value: AbsoluteLength): Self;
    bottom<Self extends Element>(this: Self, value: Length): Self;
    flex_basis<Self extends Element>(this: Self, value: Length): Self;
    flex_grow<Self extends Element>(this: Self, value: number): Self;
    flex_shrink<Self extends Element>(this: Self, value: number): Self;
    font_family<Self extends Element>(this: Self, value: string): Self;
    font_weight<Self extends Element>(this: Self, value: number): Self;
    gap<Self extends Element>(this: Self, value: DefiniteLength): Self;
    gap_x<Self extends Element>(this: Self, value: DefiniteLength): Self;
    gap_y<Self extends Element>(this: Self, value: DefiniteLength): Self;
    h<Self extends Element>(this: Self, value: Length): Self;
    inset<Self extends Element>(this: Self, value: Length): Self;
    left<Self extends Element>(this: Self, value: Length): Self;
    line_height<Self extends Element>(this: Self, value: DefiniteLength): Self;
    m<Self extends Element>(this: Self, value: Length): Self;
    max_h<Self extends Element>(this: Self, value: Length): Self;
    max_size<Self extends Element>(this: Self, value: Length): Self;
    max_w<Self extends Element>(this: Self, value: Length): Self;
    mb<Self extends Element>(this: Self, value: Length): Self;
    min_h<Self extends Element>(this: Self, value: Length): Self;
    min_size<Self extends Element>(this: Self, value: Length): Self;
    min_w<Self extends Element>(this: Self, value: Length): Self;
    ml<Self extends Element>(this: Self, value: Length): Self;
    mr<Self extends Element>(this: Self, value: Length): Self;
    mt<Self extends Element>(this: Self, value: Length): Self;
    mx<Self extends Element>(this: Self, value: Length): Self;
    my<Self extends Element>(this: Self, value: Length): Self;
    opacity<Self extends Element>(this: Self, value: number): Self;
    p<Self extends Element>(this: Self, value: DefiniteLength): Self;
    pb<Self extends Element>(this: Self, value: DefiniteLength): Self;
    pl<Self extends Element>(this: Self, value: DefiniteLength): Self;
    pr<Self extends Element>(this: Self, value: DefiniteLength): Self;
    pt<Self extends Element>(this: Self, value: DefiniteLength): Self;
    px<Self extends Element>(this: Self, value: DefiniteLength): Self;
    py<Self extends Element>(this: Self, value: DefiniteLength): Self;
    right<Self extends Element>(this: Self, value: Length): Self;
    rounded<Self extends Element>(this: Self, value: AbsoluteLength): Self;
    rounded_b<Self extends Element>(this: Self, value: AbsoluteLength): Self;
    rounded_bl<Self extends Element>(this: Self, value: AbsoluteLength): Self;
    rounded_br<Self extends Element>(this: Self, value: AbsoluteLength): Self;
    rounded_l<Self extends Element>(this: Self, value: AbsoluteLength): Self;
    rounded_r<Self extends Element>(this: Self, value: AbsoluteLength): Self;
    rounded_t<Self extends Element>(this: Self, value: AbsoluteLength): Self;
    rounded_tl<Self extends Element>(this: Self, value: AbsoluteLength): Self;
    rounded_tr<Self extends Element>(this: Self, value: AbsoluteLength): Self;
    size<Self extends Element>(this: Self, value: Length): Self;
    text_bg<Self extends Element>(this: Self, value: Color): Self;
    text_color<Self extends Element>(this: Self, value: Color): Self;
    text_size<Self extends Element>(this: Self, value: AbsoluteLength): Self;
    top<Self extends Element>(this: Self, value: Length): Self;
    w<Self extends Element>(this: Self, value: Length): Self;
    absolute<Self extends Element>(this: Self): Self;
    aspect_square<Self extends Element>(this: Self): Self;
    block<Self extends Element>(this: Self): Self;
    border_0<Self extends Element>(this: Self): Self;
    border_1<Self extends Element>(this: Self): Self;
    border_10<Self extends Element>(this: Self): Self;
    border_11<Self extends Element>(this: Self): Self;
    border_12<Self extends Element>(this: Self): Self;
    border_16<Self extends Element>(this: Self): Self;
    border_2<Self extends Element>(this: Self): Self;
    border_20<Self extends Element>(this: Self): Self;
    border_24<Self extends Element>(this: Self): Self;
    border_3<Self extends Element>(this: Self): Self;
    border_32<Self extends Element>(this: Self): Self;
    border_4<Self extends Element>(this: Self): Self;
    border_5<Self extends Element>(this: Self): Self;
    border_6<Self extends Element>(this: Self): Self;
    border_7<Self extends Element>(this: Self): Self;
    border_8<Self extends Element>(this: Self): Self;
    border_9<Self extends Element>(this: Self): Self;
    border_b_0<Self extends Element>(this: Self): Self;
    border_b_1<Self extends Element>(this: Self): Self;
    border_b_10<Self extends Element>(this: Self): Self;
    border_b_11<Self extends Element>(this: Self): Self;
    border_b_12<Self extends Element>(this: Self): Self;
    border_b_16<Self extends Element>(this: Self): Self;
    border_b_2<Self extends Element>(this: Self): Self;
    border_b_20<Self extends Element>(this: Self): Self;
    border_b_24<Self extends Element>(this: Self): Self;
    border_b_3<Self extends Element>(this: Self): Self;
    border_b_32<Self extends Element>(this: Self): Self;
    border_b_4<Self extends Element>(this: Self): Self;
    border_b_5<Self extends Element>(this: Self): Self;
    border_b_6<Self extends Element>(this: Self): Self;
    border_b_7<Self extends Element>(this: Self): Self;
    border_b_8<Self extends Element>(this: Self): Self;
    border_b_9<Self extends Element>(this: Self): Self;
    border_dashed<Self extends Element>(this: Self): Self;
    border_l_0<Self extends Element>(this: Self): Self;
    border_l_1<Self extends Element>(this: Self): Self;
    border_l_10<Self extends Element>(this: Self): Self;
    border_l_11<Self extends Element>(this: Self): Self;
    border_l_12<Self extends Element>(this: Self): Self;
    border_l_16<Self extends Element>(this: Self): Self;
    border_l_2<Self extends Element>(this: Self): Self;
    border_l_20<Self extends Element>(this: Self): Self;
    border_l_24<Self extends Element>(this: Self): Self;
    border_l_3<Self extends Element>(this: Self): Self;
    border_l_32<Self extends Element>(this: Self): Self;
    border_l_4<Self extends Element>(this: Self): Self;
    border_l_5<Self extends Element>(this: Self): Self;
    border_l_6<Self extends Element>(this: Self): Self;
    border_l_7<Self extends Element>(this: Self): Self;
    border_l_8<Self extends Element>(this: Self): Self;
    border_l_9<Self extends Element>(this: Self): Self;
    border_r_0<Self extends Element>(this: Self): Self;
    border_r_1<Self extends Element>(this: Self): Self;
    border_r_10<Self extends Element>(this: Self): Self;
    border_r_11<Self extends Element>(this: Self): Self;
    border_r_12<Self extends Element>(this: Self): Self;
    border_r_16<Self extends Element>(this: Self): Self;
    border_r_2<Self extends Element>(this: Self): Self;
    border_r_20<Self extends Element>(this: Self): Self;
    border_r_24<Self extends Element>(this: Self): Self;
    border_r_3<Self extends Element>(this: Self): Self;
    border_r_32<Self extends Element>(this: Self): Self;
    border_r_4<Self extends Element>(this: Self): Self;
    border_r_5<Self extends Element>(this: Self): Self;
    border_r_6<Self extends Element>(this: Self): Self;
    border_r_7<Self extends Element>(this: Self): Self;
    border_r_8<Self extends Element>(this: Self): Self;
    border_r_9<Self extends Element>(this: Self): Self;
    border_t_0<Self extends Element>(this: Self): Self;
    border_t_1<Self extends Element>(this: Self): Self;
    border_t_10<Self extends Element>(this: Self): Self;
    border_t_11<Self extends Element>(this: Self): Self;
    border_t_12<Self extends Element>(this: Self): Self;
    border_t_16<Self extends Element>(this: Self): Self;
    border_t_2<Self extends Element>(this: Self): Self;
    border_t_20<Self extends Element>(this: Self): Self;
    border_t_24<Self extends Element>(this: Self): Self;
    border_t_3<Self extends Element>(this: Self): Self;
    border_t_32<Self extends Element>(this: Self): Self;
    border_t_4<Self extends Element>(this: Self): Self;
    border_t_5<Self extends Element>(this: Self): Self;
    border_t_6<Self extends Element>(this: Self): Self;
    border_t_7<Self extends Element>(this: Self): Self;
    border_t_8<Self extends Element>(this: Self): Self;
    border_t_9<Self extends Element>(this: Self): Self;
    border_x_0<Self extends Element>(this: Self): Self;
    border_x_1<Self extends Element>(this: Self): Self;
    border_x_10<Self extends Element>(this: Self): Self;
    border_x_11<Self extends Element>(this: Self): Self;
    border_x_12<Self extends Element>(this: Self): Self;
    border_x_16<Self extends Element>(this: Self): Self;
    border_x_2<Self extends Element>(this: Self): Self;
    border_x_20<Self extends Element>(this: Self): Self;
    border_x_24<Self extends Element>(this: Self): Self;
    border_x_3<Self extends Element>(this: Self): Self;
    border_x_32<Self extends Element>(this: Self): Self;
    border_x_4<Self extends Element>(this: Self): Self;
    border_x_5<Self extends Element>(this: Self): Self;
    border_x_6<Self extends Element>(this: Self): Self;
    border_x_7<Self extends Element>(this: Self): Self;
    border_x_8<Self extends Element>(this: Self): Self;
    border_x_9<Self extends Element>(this: Self): Self;
    border_y_0<Self extends Element>(this: Self): Self;
    border_y_1<Self extends Element>(this: Self): Self;
    border_y_10<Self extends Element>(this: Self): Self;
    border_y_11<Self extends Element>(this: Self): Self;
    border_y_12<Self extends Element>(this: Self): Self;
    border_y_16<Self extends Element>(this: Self): Self;
    border_y_2<Self extends Element>(this: Self): Self;
    border_y_20<Self extends Element>(this: Self): Self;
    border_y_24<Self extends Element>(this: Self): Self;
    border_y_3<Self extends Element>(this: Self): Self;
    border_y_32<Self extends Element>(this: Self): Self;
    border_y_4<Self extends Element>(this: Self): Self;
    border_y_5<Self extends Element>(this: Self): Self;
    border_y_6<Self extends Element>(this: Self): Self;
    border_y_7<Self extends Element>(this: Self): Self;
    border_y_8<Self extends Element>(this: Self): Self;
    border_y_9<Self extends Element>(this: Self): Self;
    bottom_0<Self extends Element>(this: Self): Self;
    bottom_0p5<Self extends Element>(this: Self): Self;
    bottom_1<Self extends Element>(this: Self): Self;
    bottom_10<Self extends Element>(this: Self): Self;
    bottom_11<Self extends Element>(this: Self): Self;
    bottom_112<Self extends Element>(this: Self): Self;
    bottom_12<Self extends Element>(this: Self): Self;
    bottom_128<Self extends Element>(this: Self): Self;
    bottom_16<Self extends Element>(this: Self): Self;
    bottom_1_12<Self extends Element>(this: Self): Self;
    bottom_1_2<Self extends Element>(this: Self): Self;
    bottom_1_3<Self extends Element>(this: Self): Self;
    bottom_1_4<Self extends Element>(this: Self): Self;
    bottom_1_5<Self extends Element>(this: Self): Self;
    bottom_1_6<Self extends Element>(this: Self): Self;
    bottom_1p5<Self extends Element>(this: Self): Self;
    bottom_2<Self extends Element>(this: Self): Self;
    bottom_20<Self extends Element>(this: Self): Self;
    bottom_24<Self extends Element>(this: Self): Self;
    bottom_2_3<Self extends Element>(this: Self): Self;
    bottom_2_4<Self extends Element>(this: Self): Self;
    bottom_2_5<Self extends Element>(this: Self): Self;
    bottom_2p5<Self extends Element>(this: Self): Self;
    bottom_3<Self extends Element>(this: Self): Self;
    bottom_32<Self extends Element>(this: Self): Self;
    bottom_3_4<Self extends Element>(this: Self): Self;
    bottom_3_5<Self extends Element>(this: Self): Self;
    bottom_3p5<Self extends Element>(this: Self): Self;
    bottom_4<Self extends Element>(this: Self): Self;
    bottom_40<Self extends Element>(this: Self): Self;
    bottom_48<Self extends Element>(this: Self): Self;
    bottom_4_5<Self extends Element>(this: Self): Self;
    bottom_5<Self extends Element>(this: Self): Self;
    bottom_56<Self extends Element>(this: Self): Self;
    bottom_5_6<Self extends Element>(this: Self): Self;
    bottom_6<Self extends Element>(this: Self): Self;
    bottom_64<Self extends Element>(this: Self): Self;
    bottom_7<Self extends Element>(this: Self): Self;
    bottom_72<Self extends Element>(this: Self): Self;
    bottom_8<Self extends Element>(this: Self): Self;
    bottom_80<Self extends Element>(this: Self): Self;
    bottom_9<Self extends Element>(this: Self): Self;
    bottom_96<Self extends Element>(this: Self): Self;
    bottom_auto<Self extends Element>(this: Self): Self;
    bottom_full<Self extends Element>(this: Self): Self;
    bottom_neg_0<Self extends Element>(this: Self): Self;
    bottom_neg_0p5<Self extends Element>(this: Self): Self;
    bottom_neg_1<Self extends Element>(this: Self): Self;
    bottom_neg_10<Self extends Element>(this: Self): Self;
    bottom_neg_11<Self extends Element>(this: Self): Self;
    bottom_neg_112<Self extends Element>(this: Self): Self;
    bottom_neg_12<Self extends Element>(this: Self): Self;
    bottom_neg_128<Self extends Element>(this: Self): Self;
    bottom_neg_16<Self extends Element>(this: Self): Self;
    bottom_neg_1_12<Self extends Element>(this: Self): Self;
    bottom_neg_1_2<Self extends Element>(this: Self): Self;
    bottom_neg_1_3<Self extends Element>(this: Self): Self;
    bottom_neg_1_4<Self extends Element>(this: Self): Self;
    bottom_neg_1_5<Self extends Element>(this: Self): Self;
    bottom_neg_1_6<Self extends Element>(this: Self): Self;
    bottom_neg_1p5<Self extends Element>(this: Self): Self;
    bottom_neg_2<Self extends Element>(this: Self): Self;
    bottom_neg_20<Self extends Element>(this: Self): Self;
    bottom_neg_24<Self extends Element>(this: Self): Self;
    bottom_neg_2_3<Self extends Element>(this: Self): Self;
    bottom_neg_2_4<Self extends Element>(this: Self): Self;
    bottom_neg_2_5<Self extends Element>(this: Self): Self;
    bottom_neg_2p5<Self extends Element>(this: Self): Self;
    bottom_neg_3<Self extends Element>(this: Self): Self;
    bottom_neg_32<Self extends Element>(this: Self): Self;
    bottom_neg_3_4<Self extends Element>(this: Self): Self;
    bottom_neg_3_5<Self extends Element>(this: Self): Self;
    bottom_neg_3p5<Self extends Element>(this: Self): Self;
    bottom_neg_4<Self extends Element>(this: Self): Self;
    bottom_neg_40<Self extends Element>(this: Self): Self;
    bottom_neg_48<Self extends Element>(this: Self): Self;
    bottom_neg_4_5<Self extends Element>(this: Self): Self;
    bottom_neg_5<Self extends Element>(this: Self): Self;
    bottom_neg_56<Self extends Element>(this: Self): Self;
    bottom_neg_5_6<Self extends Element>(this: Self): Self;
    bottom_neg_6<Self extends Element>(this: Self): Self;
    bottom_neg_64<Self extends Element>(this: Self): Self;
    bottom_neg_7<Self extends Element>(this: Self): Self;
    bottom_neg_72<Self extends Element>(this: Self): Self;
    bottom_neg_8<Self extends Element>(this: Self): Self;
    bottom_neg_80<Self extends Element>(this: Self): Self;
    bottom_neg_9<Self extends Element>(this: Self): Self;
    bottom_neg_96<Self extends Element>(this: Self): Self;
    bottom_neg_full<Self extends Element>(this: Self): Self;
    bottom_neg_px<Self extends Element>(this: Self): Self;
    bottom_px<Self extends Element>(this: Self): Self;
    col_end_auto<Self extends Element>(this: Self): Self;
    col_span_full<Self extends Element>(this: Self): Self;
    col_start_auto<Self extends Element>(this: Self): Self;
    content_around<Self extends Element>(this: Self): Self;
    content_between<Self extends Element>(this: Self): Self;
    content_center<Self extends Element>(this: Self): Self;
    content_end<Self extends Element>(this: Self): Self;
    content_evenly<Self extends Element>(this: Self): Self;
    content_normal<Self extends Element>(this: Self): Self;
    content_start<Self extends Element>(this: Self): Self;
    content_stretch<Self extends Element>(this: Self): Self;
    cursor_alias<Self extends Element>(this: Self): Self;
    cursor_col_resize<Self extends Element>(this: Self): Self;
    cursor_context_menu<Self extends Element>(this: Self): Self;
    cursor_copy<Self extends Element>(this: Self): Self;
    cursor_crosshair<Self extends Element>(this: Self): Self;
    cursor_default<Self extends Element>(this: Self): Self;
    cursor_e_resize<Self extends Element>(this: Self): Self;
    cursor_ew_resize<Self extends Element>(this: Self): Self;
    cursor_grab<Self extends Element>(this: Self): Self;
    cursor_grabbing<Self extends Element>(this: Self): Self;
    cursor_move<Self extends Element>(this: Self): Self;
    cursor_n_resize<Self extends Element>(this: Self): Self;
    cursor_nesw_resize<Self extends Element>(this: Self): Self;
    cursor_no_drop<Self extends Element>(this: Self): Self;
    cursor_not_allowed<Self extends Element>(this: Self): Self;
    cursor_ns_resize<Self extends Element>(this: Self): Self;
    cursor_nwse_resize<Self extends Element>(this: Self): Self;
    cursor_pointer<Self extends Element>(this: Self): Self;
    cursor_row_resize<Self extends Element>(this: Self): Self;
    cursor_s_resize<Self extends Element>(this: Self): Self;
    cursor_text<Self extends Element>(this: Self): Self;
    cursor_vertical_text<Self extends Element>(this: Self): Self;
    cursor_w_resize<Self extends Element>(this: Self): Self;
    debug_blue<Self extends Element>(this: Self): Self;
    debug_green<Self extends Element>(this: Self): Self;
    debug_pink<Self extends Element>(this: Self): Self;
    debug_red<Self extends Element>(this: Self): Self;
    debug_yellow<Self extends Element>(this: Self): Self;
    flex<Self extends Element>(this: Self): Self;
    flex_1<Self extends Element>(this: Self): Self;
    flex_auto<Self extends Element>(this: Self): Self;
    flex_col<Self extends Element>(this: Self): Self;
    flex_col_reverse<Self extends Element>(this: Self): Self;
    flex_grow_0<Self extends Element>(this: Self): Self;
    flex_grow_1<Self extends Element>(this: Self): Self;
    flex_initial<Self extends Element>(this: Self): Self;
    flex_none<Self extends Element>(this: Self): Self;
    flex_nowrap<Self extends Element>(this: Self): Self;
    flex_row<Self extends Element>(this: Self): Self;
    flex_row_reverse<Self extends Element>(this: Self): Self;
    flex_shrink_0<Self extends Element>(this: Self): Self;
    flex_shrink_1<Self extends Element>(this: Self): Self;
    flex_wrap<Self extends Element>(this: Self): Self;
    flex_wrap_reverse<Self extends Element>(this: Self): Self;
    font_black<Self extends Element>(this: Self): Self;
    font_bold<Self extends Element>(this: Self): Self;
    font_extrabold<Self extends Element>(this: Self): Self;
    font_extralight<Self extends Element>(this: Self): Self;
    font_light<Self extends Element>(this: Self): Self;
    font_medium<Self extends Element>(this: Self): Self;
    font_normal<Self extends Element>(this: Self): Self;
    font_semibold<Self extends Element>(this: Self): Self;
    font_thin<Self extends Element>(this: Self): Self;
    gap_0<Self extends Element>(this: Self): Self;
    gap_0p5<Self extends Element>(this: Self): Self;
    gap_1<Self extends Element>(this: Self): Self;
    gap_10<Self extends Element>(this: Self): Self;
    gap_11<Self extends Element>(this: Self): Self;
    gap_112<Self extends Element>(this: Self): Self;
    gap_12<Self extends Element>(this: Self): Self;
    gap_128<Self extends Element>(this: Self): Self;
    gap_16<Self extends Element>(this: Self): Self;
    gap_1_12<Self extends Element>(this: Self): Self;
    gap_1_2<Self extends Element>(this: Self): Self;
    gap_1_3<Self extends Element>(this: Self): Self;
    gap_1_4<Self extends Element>(this: Self): Self;
    gap_1_5<Self extends Element>(this: Self): Self;
    gap_1_6<Self extends Element>(this: Self): Self;
    gap_1p5<Self extends Element>(this: Self): Self;
    gap_2<Self extends Element>(this: Self): Self;
    gap_20<Self extends Element>(this: Self): Self;
    gap_24<Self extends Element>(this: Self): Self;
    gap_2_3<Self extends Element>(this: Self): Self;
    gap_2_4<Self extends Element>(this: Self): Self;
    gap_2_5<Self extends Element>(this: Self): Self;
    gap_2p5<Self extends Element>(this: Self): Self;
    gap_3<Self extends Element>(this: Self): Self;
    gap_32<Self extends Element>(this: Self): Self;
    gap_3_4<Self extends Element>(this: Self): Self;
    gap_3_5<Self extends Element>(this: Self): Self;
    gap_3p5<Self extends Element>(this: Self): Self;
    gap_4<Self extends Element>(this: Self): Self;
    gap_40<Self extends Element>(this: Self): Self;
    gap_48<Self extends Element>(this: Self): Self;
    gap_4_5<Self extends Element>(this: Self): Self;
    gap_5<Self extends Element>(this: Self): Self;
    gap_56<Self extends Element>(this: Self): Self;
    gap_5_6<Self extends Element>(this: Self): Self;
    gap_6<Self extends Element>(this: Self): Self;
    gap_64<Self extends Element>(this: Self): Self;
    gap_7<Self extends Element>(this: Self): Self;
    gap_72<Self extends Element>(this: Self): Self;
    gap_8<Self extends Element>(this: Self): Self;
    gap_80<Self extends Element>(this: Self): Self;
    gap_9<Self extends Element>(this: Self): Self;
    gap_96<Self extends Element>(this: Self): Self;
    gap_full<Self extends Element>(this: Self): Self;
    gap_neg_0<Self extends Element>(this: Self): Self;
    gap_neg_0p5<Self extends Element>(this: Self): Self;
    gap_neg_1<Self extends Element>(this: Self): Self;
    gap_neg_10<Self extends Element>(this: Self): Self;
    gap_neg_11<Self extends Element>(this: Self): Self;
    gap_neg_112<Self extends Element>(this: Self): Self;
    gap_neg_12<Self extends Element>(this: Self): Self;
    gap_neg_128<Self extends Element>(this: Self): Self;
    gap_neg_16<Self extends Element>(this: Self): Self;
    gap_neg_1_12<Self extends Element>(this: Self): Self;
    gap_neg_1_2<Self extends Element>(this: Self): Self;
    gap_neg_1_3<Self extends Element>(this: Self): Self;
    gap_neg_1_4<Self extends Element>(this: Self): Self;
    gap_neg_1_5<Self extends Element>(this: Self): Self;
    gap_neg_1_6<Self extends Element>(this: Self): Self;
    gap_neg_1p5<Self extends Element>(this: Self): Self;
    gap_neg_2<Self extends Element>(this: Self): Self;
    gap_neg_20<Self extends Element>(this: Self): Self;
    gap_neg_24<Self extends Element>(this: Self): Self;
    gap_neg_2_3<Self extends Element>(this: Self): Self;
    gap_neg_2_4<Self extends Element>(this: Self): Self;
    gap_neg_2_5<Self extends Element>(this: Self): Self;
    gap_neg_2p5<Self extends Element>(this: Self): Self;
    gap_neg_3<Self extends Element>(this: Self): Self;
    gap_neg_32<Self extends Element>(this: Self): Self;
    gap_neg_3_4<Self extends Element>(this: Self): Self;
    gap_neg_3_5<Self extends Element>(this: Self): Self;
    gap_neg_3p5<Self extends Element>(this: Self): Self;
    gap_neg_4<Self extends Element>(this: Self): Self;
    gap_neg_40<Self extends Element>(this: Self): Self;
    gap_neg_48<Self extends Element>(this: Self): Self;
    gap_neg_4_5<Self extends Element>(this: Self): Self;
    gap_neg_5<Self extends Element>(this: Self): Self;
    gap_neg_56<Self extends Element>(this: Self): Self;
    gap_neg_5_6<Self extends Element>(this: Self): Self;
    gap_neg_6<Self extends Element>(this: Self): Self;
    gap_neg_64<Self extends Element>(this: Self): Self;
    gap_neg_7<Self extends Element>(this: Self): Self;
    gap_neg_72<Self extends Element>(this: Self): Self;
    gap_neg_8<Self extends Element>(this: Self): Self;
    gap_neg_80<Self extends Element>(this: Self): Self;
    gap_neg_9<Self extends Element>(this: Self): Self;
    gap_neg_96<Self extends Element>(this: Self): Self;
    gap_neg_full<Self extends Element>(this: Self): Self;
    gap_neg_px<Self extends Element>(this: Self): Self;
    gap_px<Self extends Element>(this: Self): Self;
    gap_x_0<Self extends Element>(this: Self): Self;
    gap_x_0p5<Self extends Element>(this: Self): Self;
    gap_x_1<Self extends Element>(this: Self): Self;
    gap_x_10<Self extends Element>(this: Self): Self;
    gap_x_11<Self extends Element>(this: Self): Self;
    gap_x_112<Self extends Element>(this: Self): Self;
    gap_x_12<Self extends Element>(this: Self): Self;
    gap_x_128<Self extends Element>(this: Self): Self;
    gap_x_16<Self extends Element>(this: Self): Self;
    gap_x_1_12<Self extends Element>(this: Self): Self;
    gap_x_1_2<Self extends Element>(this: Self): Self;
    gap_x_1_3<Self extends Element>(this: Self): Self;
    gap_x_1_4<Self extends Element>(this: Self): Self;
    gap_x_1_5<Self extends Element>(this: Self): Self;
    gap_x_1_6<Self extends Element>(this: Self): Self;
    gap_x_1p5<Self extends Element>(this: Self): Self;
    gap_x_2<Self extends Element>(this: Self): Self;
    gap_x_20<Self extends Element>(this: Self): Self;
    gap_x_24<Self extends Element>(this: Self): Self;
    gap_x_2_3<Self extends Element>(this: Self): Self;
    gap_x_2_4<Self extends Element>(this: Self): Self;
    gap_x_2_5<Self extends Element>(this: Self): Self;
    gap_x_2p5<Self extends Element>(this: Self): Self;
    gap_x_3<Self extends Element>(this: Self): Self;
    gap_x_32<Self extends Element>(this: Self): Self;
    gap_x_3_4<Self extends Element>(this: Self): Self;
    gap_x_3_5<Self extends Element>(this: Self): Self;
    gap_x_3p5<Self extends Element>(this: Self): Self;
    gap_x_4<Self extends Element>(this: Self): Self;
    gap_x_40<Self extends Element>(this: Self): Self;
    gap_x_48<Self extends Element>(this: Self): Self;
    gap_x_4_5<Self extends Element>(this: Self): Self;
    gap_x_5<Self extends Element>(this: Self): Self;
    gap_x_56<Self extends Element>(this: Self): Self;
    gap_x_5_6<Self extends Element>(this: Self): Self;
    gap_x_6<Self extends Element>(this: Self): Self;
    gap_x_64<Self extends Element>(this: Self): Self;
    gap_x_7<Self extends Element>(this: Self): Self;
    gap_x_72<Self extends Element>(this: Self): Self;
    gap_x_8<Self extends Element>(this: Self): Self;
    gap_x_80<Self extends Element>(this: Self): Self;
    gap_x_9<Self extends Element>(this: Self): Self;
    gap_x_96<Self extends Element>(this: Self): Self;
    gap_x_full<Self extends Element>(this: Self): Self;
    gap_x_neg_0<Self extends Element>(this: Self): Self;
    gap_x_neg_0p5<Self extends Element>(this: Self): Self;
    gap_x_neg_1<Self extends Element>(this: Self): Self;
    gap_x_neg_10<Self extends Element>(this: Self): Self;
    gap_x_neg_11<Self extends Element>(this: Self): Self;
    gap_x_neg_112<Self extends Element>(this: Self): Self;
    gap_x_neg_12<Self extends Element>(this: Self): Self;
    gap_x_neg_128<Self extends Element>(this: Self): Self;
    gap_x_neg_16<Self extends Element>(this: Self): Self;
    gap_x_neg_1_12<Self extends Element>(this: Self): Self;
    gap_x_neg_1_2<Self extends Element>(this: Self): Self;
    gap_x_neg_1_3<Self extends Element>(this: Self): Self;
    gap_x_neg_1_4<Self extends Element>(this: Self): Self;
    gap_x_neg_1_5<Self extends Element>(this: Self): Self;
    gap_x_neg_1_6<Self extends Element>(this: Self): Self;
    gap_x_neg_1p5<Self extends Element>(this: Self): Self;
    gap_x_neg_2<Self extends Element>(this: Self): Self;
    gap_x_neg_20<Self extends Element>(this: Self): Self;
    gap_x_neg_24<Self extends Element>(this: Self): Self;
    gap_x_neg_2_3<Self extends Element>(this: Self): Self;
    gap_x_neg_2_4<Self extends Element>(this: Self): Self;
    gap_x_neg_2_5<Self extends Element>(this: Self): Self;
    gap_x_neg_2p5<Self extends Element>(this: Self): Self;
    gap_x_neg_3<Self extends Element>(this: Self): Self;
    gap_x_neg_32<Self extends Element>(this: Self): Self;
    gap_x_neg_3_4<Self extends Element>(this: Self): Self;
    gap_x_neg_3_5<Self extends Element>(this: Self): Self;
    gap_x_neg_3p5<Self extends Element>(this: Self): Self;
    gap_x_neg_4<Self extends Element>(this: Self): Self;
    gap_x_neg_40<Self extends Element>(this: Self): Self;
    gap_x_neg_48<Self extends Element>(this: Self): Self;
    gap_x_neg_4_5<Self extends Element>(this: Self): Self;
    gap_x_neg_5<Self extends Element>(this: Self): Self;
    gap_x_neg_56<Self extends Element>(this: Self): Self;
    gap_x_neg_5_6<Self extends Element>(this: Self): Self;
    gap_x_neg_6<Self extends Element>(this: Self): Self;
    gap_x_neg_64<Self extends Element>(this: Self): Self;
    gap_x_neg_7<Self extends Element>(this: Self): Self;
    gap_x_neg_72<Self extends Element>(this: Self): Self;
    gap_x_neg_8<Self extends Element>(this: Self): Self;
    gap_x_neg_80<Self extends Element>(this: Self): Self;
    gap_x_neg_9<Self extends Element>(this: Self): Self;
    gap_x_neg_96<Self extends Element>(this: Self): Self;
    gap_x_neg_full<Self extends Element>(this: Self): Self;
    gap_x_neg_px<Self extends Element>(this: Self): Self;
    gap_x_px<Self extends Element>(this: Self): Self;
    gap_y_0<Self extends Element>(this: Self): Self;
    gap_y_0p5<Self extends Element>(this: Self): Self;
    gap_y_1<Self extends Element>(this: Self): Self;
    gap_y_10<Self extends Element>(this: Self): Self;
    gap_y_11<Self extends Element>(this: Self): Self;
    gap_y_112<Self extends Element>(this: Self): Self;
    gap_y_12<Self extends Element>(this: Self): Self;
    gap_y_128<Self extends Element>(this: Self): Self;
    gap_y_16<Self extends Element>(this: Self): Self;
    gap_y_1_12<Self extends Element>(this: Self): Self;
    gap_y_1_2<Self extends Element>(this: Self): Self;
    gap_y_1_3<Self extends Element>(this: Self): Self;
    gap_y_1_4<Self extends Element>(this: Self): Self;
    gap_y_1_5<Self extends Element>(this: Self): Self;
    gap_y_1_6<Self extends Element>(this: Self): Self;
    gap_y_1p5<Self extends Element>(this: Self): Self;
    gap_y_2<Self extends Element>(this: Self): Self;
    gap_y_20<Self extends Element>(this: Self): Self;
    gap_y_24<Self extends Element>(this: Self): Self;
    gap_y_2_3<Self extends Element>(this: Self): Self;
    gap_y_2_4<Self extends Element>(this: Self): Self;
    gap_y_2_5<Self extends Element>(this: Self): Self;
    gap_y_2p5<Self extends Element>(this: Self): Self;
    gap_y_3<Self extends Element>(this: Self): Self;
    gap_y_32<Self extends Element>(this: Self): Self;
    gap_y_3_4<Self extends Element>(this: Self): Self;
    gap_y_3_5<Self extends Element>(this: Self): Self;
    gap_y_3p5<Self extends Element>(this: Self): Self;
    gap_y_4<Self extends Element>(this: Self): Self;
    gap_y_40<Self extends Element>(this: Self): Self;
    gap_y_48<Self extends Element>(this: Self): Self;
    gap_y_4_5<Self extends Element>(this: Self): Self;
    gap_y_5<Self extends Element>(this: Self): Self;
    gap_y_56<Self extends Element>(this: Self): Self;
    gap_y_5_6<Self extends Element>(this: Self): Self;
    gap_y_6<Self extends Element>(this: Self): Self;
    gap_y_64<Self extends Element>(this: Self): Self;
    gap_y_7<Self extends Element>(this: Self): Self;
    gap_y_72<Self extends Element>(this: Self): Self;
    gap_y_8<Self extends Element>(this: Self): Self;
    gap_y_80<Self extends Element>(this: Self): Self;
    gap_y_9<Self extends Element>(this: Self): Self;
    gap_y_96<Self extends Element>(this: Self): Self;
    gap_y_full<Self extends Element>(this: Self): Self;
    gap_y_neg_0<Self extends Element>(this: Self): Self;
    gap_y_neg_0p5<Self extends Element>(this: Self): Self;
    gap_y_neg_1<Self extends Element>(this: Self): Self;
    gap_y_neg_10<Self extends Element>(this: Self): Self;
    gap_y_neg_11<Self extends Element>(this: Self): Self;
    gap_y_neg_112<Self extends Element>(this: Self): Self;
    gap_y_neg_12<Self extends Element>(this: Self): Self;
    gap_y_neg_128<Self extends Element>(this: Self): Self;
    gap_y_neg_16<Self extends Element>(this: Self): Self;
    gap_y_neg_1_12<Self extends Element>(this: Self): Self;
    gap_y_neg_1_2<Self extends Element>(this: Self): Self;
    gap_y_neg_1_3<Self extends Element>(this: Self): Self;
    gap_y_neg_1_4<Self extends Element>(this: Self): Self;
    gap_y_neg_1_5<Self extends Element>(this: Self): Self;
    gap_y_neg_1_6<Self extends Element>(this: Self): Self;
    gap_y_neg_1p5<Self extends Element>(this: Self): Self;
    gap_y_neg_2<Self extends Element>(this: Self): Self;
    gap_y_neg_20<Self extends Element>(this: Self): Self;
    gap_y_neg_24<Self extends Element>(this: Self): Self;
    gap_y_neg_2_3<Self extends Element>(this: Self): Self;
    gap_y_neg_2_4<Self extends Element>(this: Self): Self;
    gap_y_neg_2_5<Self extends Element>(this: Self): Self;
    gap_y_neg_2p5<Self extends Element>(this: Self): Self;
    gap_y_neg_3<Self extends Element>(this: Self): Self;
    gap_y_neg_32<Self extends Element>(this: Self): Self;
    gap_y_neg_3_4<Self extends Element>(this: Self): Self;
    gap_y_neg_3_5<Self extends Element>(this: Self): Self;
    gap_y_neg_3p5<Self extends Element>(this: Self): Self;
    gap_y_neg_4<Self extends Element>(this: Self): Self;
    gap_y_neg_40<Self extends Element>(this: Self): Self;
    gap_y_neg_48<Self extends Element>(this: Self): Self;
    gap_y_neg_4_5<Self extends Element>(this: Self): Self;
    gap_y_neg_5<Self extends Element>(this: Self): Self;
    gap_y_neg_56<Self extends Element>(this: Self): Self;
    gap_y_neg_5_6<Self extends Element>(this: Self): Self;
    gap_y_neg_6<Self extends Element>(this: Self): Self;
    gap_y_neg_64<Self extends Element>(this: Self): Self;
    gap_y_neg_7<Self extends Element>(this: Self): Self;
    gap_y_neg_72<Self extends Element>(this: Self): Self;
    gap_y_neg_8<Self extends Element>(this: Self): Self;
    gap_y_neg_80<Self extends Element>(this: Self): Self;
    gap_y_neg_9<Self extends Element>(this: Self): Self;
    gap_y_neg_96<Self extends Element>(this: Self): Self;
    gap_y_neg_full<Self extends Element>(this: Self): Self;
    gap_y_neg_px<Self extends Element>(this: Self): Self;
    gap_y_px<Self extends Element>(this: Self): Self;
    grid<Self extends Element>(this: Self): Self;
    h_0<Self extends Element>(this: Self): Self;
    h_0p5<Self extends Element>(this: Self): Self;
    h_1<Self extends Element>(this: Self): Self;
    h_10<Self extends Element>(this: Self): Self;
    h_11<Self extends Element>(this: Self): Self;
    h_112<Self extends Element>(this: Self): Self;
    h_12<Self extends Element>(this: Self): Self;
    h_128<Self extends Element>(this: Self): Self;
    h_16<Self extends Element>(this: Self): Self;
    h_1_12<Self extends Element>(this: Self): Self;
    h_1_2<Self extends Element>(this: Self): Self;
    h_1_3<Self extends Element>(this: Self): Self;
    h_1_4<Self extends Element>(this: Self): Self;
    h_1_5<Self extends Element>(this: Self): Self;
    h_1_6<Self extends Element>(this: Self): Self;
    h_1p5<Self extends Element>(this: Self): Self;
    h_2<Self extends Element>(this: Self): Self;
    h_20<Self extends Element>(this: Self): Self;
    h_24<Self extends Element>(this: Self): Self;
    h_2_3<Self extends Element>(this: Self): Self;
    h_2_4<Self extends Element>(this: Self): Self;
    h_2_5<Self extends Element>(this: Self): Self;
    h_2p5<Self extends Element>(this: Self): Self;
    h_3<Self extends Element>(this: Self): Self;
    h_32<Self extends Element>(this: Self): Self;
    h_3_4<Self extends Element>(this: Self): Self;
    h_3_5<Self extends Element>(this: Self): Self;
    h_3p5<Self extends Element>(this: Self): Self;
    h_4<Self extends Element>(this: Self): Self;
    h_40<Self extends Element>(this: Self): Self;
    h_48<Self extends Element>(this: Self): Self;
    h_4_5<Self extends Element>(this: Self): Self;
    h_5<Self extends Element>(this: Self): Self;
    h_56<Self extends Element>(this: Self): Self;
    h_5_6<Self extends Element>(this: Self): Self;
    h_6<Self extends Element>(this: Self): Self;
    h_64<Self extends Element>(this: Self): Self;
    h_7<Self extends Element>(this: Self): Self;
    h_72<Self extends Element>(this: Self): Self;
    h_8<Self extends Element>(this: Self): Self;
    h_80<Self extends Element>(this: Self): Self;
    h_9<Self extends Element>(this: Self): Self;
    h_96<Self extends Element>(this: Self): Self;
    h_auto<Self extends Element>(this: Self): Self;
    h_flex<Self extends Element>(this: Self): Self;
    h_full<Self extends Element>(this: Self): Self;
    h_neg_0<Self extends Element>(this: Self): Self;
    h_neg_0p5<Self extends Element>(this: Self): Self;
    h_neg_1<Self extends Element>(this: Self): Self;
    h_neg_10<Self extends Element>(this: Self): Self;
    h_neg_11<Self extends Element>(this: Self): Self;
    h_neg_112<Self extends Element>(this: Self): Self;
    h_neg_12<Self extends Element>(this: Self): Self;
    h_neg_128<Self extends Element>(this: Self): Self;
    h_neg_16<Self extends Element>(this: Self): Self;
    h_neg_1_12<Self extends Element>(this: Self): Self;
    h_neg_1_2<Self extends Element>(this: Self): Self;
    h_neg_1_3<Self extends Element>(this: Self): Self;
    h_neg_1_4<Self extends Element>(this: Self): Self;
    h_neg_1_5<Self extends Element>(this: Self): Self;
    h_neg_1_6<Self extends Element>(this: Self): Self;
    h_neg_1p5<Self extends Element>(this: Self): Self;
    h_neg_2<Self extends Element>(this: Self): Self;
    h_neg_20<Self extends Element>(this: Self): Self;
    h_neg_24<Self extends Element>(this: Self): Self;
    h_neg_2_3<Self extends Element>(this: Self): Self;
    h_neg_2_4<Self extends Element>(this: Self): Self;
    h_neg_2_5<Self extends Element>(this: Self): Self;
    h_neg_2p5<Self extends Element>(this: Self): Self;
    h_neg_3<Self extends Element>(this: Self): Self;
    h_neg_32<Self extends Element>(this: Self): Self;
    h_neg_3_4<Self extends Element>(this: Self): Self;
    h_neg_3_5<Self extends Element>(this: Self): Self;
    h_neg_3p5<Self extends Element>(this: Self): Self;
    h_neg_4<Self extends Element>(this: Self): Self;
    h_neg_40<Self extends Element>(this: Self): Self;
    h_neg_48<Self extends Element>(this: Self): Self;
    h_neg_4_5<Self extends Element>(this: Self): Self;
    h_neg_5<Self extends Element>(this: Self): Self;
    h_neg_56<Self extends Element>(this: Self): Self;
    h_neg_5_6<Self extends Element>(this: Self): Self;
    h_neg_6<Self extends Element>(this: Self): Self;
    h_neg_64<Self extends Element>(this: Self): Self;
    h_neg_7<Self extends Element>(this: Self): Self;
    h_neg_72<Self extends Element>(this: Self): Self;
    h_neg_8<Self extends Element>(this: Self): Self;
    h_neg_80<Self extends Element>(this: Self): Self;
    h_neg_9<Self extends Element>(this: Self): Self;
    h_neg_96<Self extends Element>(this: Self): Self;
    h_neg_full<Self extends Element>(this: Self): Self;
    h_neg_px<Self extends Element>(this: Self): Self;
    h_px<Self extends Element>(this: Self): Self;
    hidden<Self extends Element>(this: Self): Self;
    inset_0<Self extends Element>(this: Self): Self;
    inset_0p5<Self extends Element>(this: Self): Self;
    inset_1<Self extends Element>(this: Self): Self;
    inset_10<Self extends Element>(this: Self): Self;
    inset_11<Self extends Element>(this: Self): Self;
    inset_112<Self extends Element>(this: Self): Self;
    inset_12<Self extends Element>(this: Self): Self;
    inset_128<Self extends Element>(this: Self): Self;
    inset_16<Self extends Element>(this: Self): Self;
    inset_1_12<Self extends Element>(this: Self): Self;
    inset_1_2<Self extends Element>(this: Self): Self;
    inset_1_3<Self extends Element>(this: Self): Self;
    inset_1_4<Self extends Element>(this: Self): Self;
    inset_1_5<Self extends Element>(this: Self): Self;
    inset_1_6<Self extends Element>(this: Self): Self;
    inset_1p5<Self extends Element>(this: Self): Self;
    inset_2<Self extends Element>(this: Self): Self;
    inset_20<Self extends Element>(this: Self): Self;
    inset_24<Self extends Element>(this: Self): Self;
    inset_2_3<Self extends Element>(this: Self): Self;
    inset_2_4<Self extends Element>(this: Self): Self;
    inset_2_5<Self extends Element>(this: Self): Self;
    inset_2p5<Self extends Element>(this: Self): Self;
    inset_3<Self extends Element>(this: Self): Self;
    inset_32<Self extends Element>(this: Self): Self;
    inset_3_4<Self extends Element>(this: Self): Self;
    inset_3_5<Self extends Element>(this: Self): Self;
    inset_3p5<Self extends Element>(this: Self): Self;
    inset_4<Self extends Element>(this: Self): Self;
    inset_40<Self extends Element>(this: Self): Self;
    inset_48<Self extends Element>(this: Self): Self;
    inset_4_5<Self extends Element>(this: Self): Self;
    inset_5<Self extends Element>(this: Self): Self;
    inset_56<Self extends Element>(this: Self): Self;
    inset_5_6<Self extends Element>(this: Self): Self;
    inset_6<Self extends Element>(this: Self): Self;
    inset_64<Self extends Element>(this: Self): Self;
    inset_7<Self extends Element>(this: Self): Self;
    inset_72<Self extends Element>(this: Self): Self;
    inset_8<Self extends Element>(this: Self): Self;
    inset_80<Self extends Element>(this: Self): Self;
    inset_9<Self extends Element>(this: Self): Self;
    inset_96<Self extends Element>(this: Self): Self;
    inset_auto<Self extends Element>(this: Self): Self;
    inset_full<Self extends Element>(this: Self): Self;
    inset_neg_0<Self extends Element>(this: Self): Self;
    inset_neg_0p5<Self extends Element>(this: Self): Self;
    inset_neg_1<Self extends Element>(this: Self): Self;
    inset_neg_10<Self extends Element>(this: Self): Self;
    inset_neg_11<Self extends Element>(this: Self): Self;
    inset_neg_112<Self extends Element>(this: Self): Self;
    inset_neg_12<Self extends Element>(this: Self): Self;
    inset_neg_128<Self extends Element>(this: Self): Self;
    inset_neg_16<Self extends Element>(this: Self): Self;
    inset_neg_1_12<Self extends Element>(this: Self): Self;
    inset_neg_1_2<Self extends Element>(this: Self): Self;
    inset_neg_1_3<Self extends Element>(this: Self): Self;
    inset_neg_1_4<Self extends Element>(this: Self): Self;
    inset_neg_1_5<Self extends Element>(this: Self): Self;
    inset_neg_1_6<Self extends Element>(this: Self): Self;
    inset_neg_1p5<Self extends Element>(this: Self): Self;
    inset_neg_2<Self extends Element>(this: Self): Self;
    inset_neg_20<Self extends Element>(this: Self): Self;
    inset_neg_24<Self extends Element>(this: Self): Self;
    inset_neg_2_3<Self extends Element>(this: Self): Self;
    inset_neg_2_4<Self extends Element>(this: Self): Self;
    inset_neg_2_5<Self extends Element>(this: Self): Self;
    inset_neg_2p5<Self extends Element>(this: Self): Self;
    inset_neg_3<Self extends Element>(this: Self): Self;
    inset_neg_32<Self extends Element>(this: Self): Self;
    inset_neg_3_4<Self extends Element>(this: Self): Self;
    inset_neg_3_5<Self extends Element>(this: Self): Self;
    inset_neg_3p5<Self extends Element>(this: Self): Self;
    inset_neg_4<Self extends Element>(this: Self): Self;
    inset_neg_40<Self extends Element>(this: Self): Self;
    inset_neg_48<Self extends Element>(this: Self): Self;
    inset_neg_4_5<Self extends Element>(this: Self): Self;
    inset_neg_5<Self extends Element>(this: Self): Self;
    inset_neg_56<Self extends Element>(this: Self): Self;
    inset_neg_5_6<Self extends Element>(this: Self): Self;
    inset_neg_6<Self extends Element>(this: Self): Self;
    inset_neg_64<Self extends Element>(this: Self): Self;
    inset_neg_7<Self extends Element>(this: Self): Self;
    inset_neg_72<Self extends Element>(this: Self): Self;
    inset_neg_8<Self extends Element>(this: Self): Self;
    inset_neg_80<Self extends Element>(this: Self): Self;
    inset_neg_9<Self extends Element>(this: Self): Self;
    inset_neg_96<Self extends Element>(this: Self): Self;
    inset_neg_full<Self extends Element>(this: Self): Self;
    inset_neg_px<Self extends Element>(this: Self): Self;
    inset_px<Self extends Element>(this: Self): Self;
    invisible<Self extends Element>(this: Self): Self;
    italic<Self extends Element>(this: Self): Self;
    items_baseline<Self extends Element>(this: Self): Self;
    items_center<Self extends Element>(this: Self): Self;
    items_end<Self extends Element>(this: Self): Self;
    items_start<Self extends Element>(this: Self): Self;
    items_stretch<Self extends Element>(this: Self): Self;
    justify_around<Self extends Element>(this: Self): Self;
    justify_between<Self extends Element>(this: Self): Self;
    justify_center<Self extends Element>(this: Self): Self;
    justify_end<Self extends Element>(this: Self): Self;
    justify_evenly<Self extends Element>(this: Self): Self;
    justify_start<Self extends Element>(this: Self): Self;
    left_0<Self extends Element>(this: Self): Self;
    left_0p5<Self extends Element>(this: Self): Self;
    left_1<Self extends Element>(this: Self): Self;
    left_10<Self extends Element>(this: Self): Self;
    left_11<Self extends Element>(this: Self): Self;
    left_112<Self extends Element>(this: Self): Self;
    left_12<Self extends Element>(this: Self): Self;
    left_128<Self extends Element>(this: Self): Self;
    left_16<Self extends Element>(this: Self): Self;
    left_1_12<Self extends Element>(this: Self): Self;
    left_1_2<Self extends Element>(this: Self): Self;
    left_1_3<Self extends Element>(this: Self): Self;
    left_1_4<Self extends Element>(this: Self): Self;
    left_1_5<Self extends Element>(this: Self): Self;
    left_1_6<Self extends Element>(this: Self): Self;
    left_1p5<Self extends Element>(this: Self): Self;
    left_2<Self extends Element>(this: Self): Self;
    left_20<Self extends Element>(this: Self): Self;
    left_24<Self extends Element>(this: Self): Self;
    left_2_3<Self extends Element>(this: Self): Self;
    left_2_4<Self extends Element>(this: Self): Self;
    left_2_5<Self extends Element>(this: Self): Self;
    left_2p5<Self extends Element>(this: Self): Self;
    left_3<Self extends Element>(this: Self): Self;
    left_32<Self extends Element>(this: Self): Self;
    left_3_4<Self extends Element>(this: Self): Self;
    left_3_5<Self extends Element>(this: Self): Self;
    left_3p5<Self extends Element>(this: Self): Self;
    left_4<Self extends Element>(this: Self): Self;
    left_40<Self extends Element>(this: Self): Self;
    left_48<Self extends Element>(this: Self): Self;
    left_4_5<Self extends Element>(this: Self): Self;
    left_5<Self extends Element>(this: Self): Self;
    left_56<Self extends Element>(this: Self): Self;
    left_5_6<Self extends Element>(this: Self): Self;
    left_6<Self extends Element>(this: Self): Self;
    left_64<Self extends Element>(this: Self): Self;
    left_7<Self extends Element>(this: Self): Self;
    left_72<Self extends Element>(this: Self): Self;
    left_8<Self extends Element>(this: Self): Self;
    left_80<Self extends Element>(this: Self): Self;
    left_9<Self extends Element>(this: Self): Self;
    left_96<Self extends Element>(this: Self): Self;
    left_auto<Self extends Element>(this: Self): Self;
    left_full<Self extends Element>(this: Self): Self;
    left_neg_0<Self extends Element>(this: Self): Self;
    left_neg_0p5<Self extends Element>(this: Self): Self;
    left_neg_1<Self extends Element>(this: Self): Self;
    left_neg_10<Self extends Element>(this: Self): Self;
    left_neg_11<Self extends Element>(this: Self): Self;
    left_neg_112<Self extends Element>(this: Self): Self;
    left_neg_12<Self extends Element>(this: Self): Self;
    left_neg_128<Self extends Element>(this: Self): Self;
    left_neg_16<Self extends Element>(this: Self): Self;
    left_neg_1_12<Self extends Element>(this: Self): Self;
    left_neg_1_2<Self extends Element>(this: Self): Self;
    left_neg_1_3<Self extends Element>(this: Self): Self;
    left_neg_1_4<Self extends Element>(this: Self): Self;
    left_neg_1_5<Self extends Element>(this: Self): Self;
    left_neg_1_6<Self extends Element>(this: Self): Self;
    left_neg_1p5<Self extends Element>(this: Self): Self;
    left_neg_2<Self extends Element>(this: Self): Self;
    left_neg_20<Self extends Element>(this: Self): Self;
    left_neg_24<Self extends Element>(this: Self): Self;
    left_neg_2_3<Self extends Element>(this: Self): Self;
    left_neg_2_4<Self extends Element>(this: Self): Self;
    left_neg_2_5<Self extends Element>(this: Self): Self;
    left_neg_2p5<Self extends Element>(this: Self): Self;
    left_neg_3<Self extends Element>(this: Self): Self;
    left_neg_32<Self extends Element>(this: Self): Self;
    left_neg_3_4<Self extends Element>(this: Self): Self;
    left_neg_3_5<Self extends Element>(this: Self): Self;
    left_neg_3p5<Self extends Element>(this: Self): Self;
    left_neg_4<Self extends Element>(this: Self): Self;
    left_neg_40<Self extends Element>(this: Self): Self;
    left_neg_48<Self extends Element>(this: Self): Self;
    left_neg_4_5<Self extends Element>(this: Self): Self;
    left_neg_5<Self extends Element>(this: Self): Self;
    left_neg_56<Self extends Element>(this: Self): Self;
    left_neg_5_6<Self extends Element>(this: Self): Self;
    left_neg_6<Self extends Element>(this: Self): Self;
    left_neg_64<Self extends Element>(this: Self): Self;
    left_neg_7<Self extends Element>(this: Self): Self;
    left_neg_72<Self extends Element>(this: Self): Self;
    left_neg_8<Self extends Element>(this: Self): Self;
    left_neg_80<Self extends Element>(this: Self): Self;
    left_neg_9<Self extends Element>(this: Self): Self;
    left_neg_96<Self extends Element>(this: Self): Self;
    left_neg_full<Self extends Element>(this: Self): Self;
    left_neg_px<Self extends Element>(this: Self): Self;
    left_px<Self extends Element>(this: Self): Self;
    line_through<Self extends Element>(this: Self): Self;
    m_0<Self extends Element>(this: Self): Self;
    m_0p5<Self extends Element>(this: Self): Self;
    m_1<Self extends Element>(this: Self): Self;
    m_10<Self extends Element>(this: Self): Self;
    m_11<Self extends Element>(this: Self): Self;
    m_112<Self extends Element>(this: Self): Self;
    m_12<Self extends Element>(this: Self): Self;
    m_128<Self extends Element>(this: Self): Self;
    m_16<Self extends Element>(this: Self): Self;
    m_1_12<Self extends Element>(this: Self): Self;
    m_1_2<Self extends Element>(this: Self): Self;
    m_1_3<Self extends Element>(this: Self): Self;
    m_1_4<Self extends Element>(this: Self): Self;
    m_1_5<Self extends Element>(this: Self): Self;
    m_1_6<Self extends Element>(this: Self): Self;
    m_1p5<Self extends Element>(this: Self): Self;
    m_2<Self extends Element>(this: Self): Self;
    m_20<Self extends Element>(this: Self): Self;
    m_24<Self extends Element>(this: Self): Self;
    m_2_3<Self extends Element>(this: Self): Self;
    m_2_4<Self extends Element>(this: Self): Self;
    m_2_5<Self extends Element>(this: Self): Self;
    m_2p5<Self extends Element>(this: Self): Self;
    m_3<Self extends Element>(this: Self): Self;
    m_32<Self extends Element>(this: Self): Self;
    m_3_4<Self extends Element>(this: Self): Self;
    m_3_5<Self extends Element>(this: Self): Self;
    m_3p5<Self extends Element>(this: Self): Self;
    m_4<Self extends Element>(this: Self): Self;
    m_40<Self extends Element>(this: Self): Self;
    m_48<Self extends Element>(this: Self): Self;
    m_4_5<Self extends Element>(this: Self): Self;
    m_5<Self extends Element>(this: Self): Self;
    m_56<Self extends Element>(this: Self): Self;
    m_5_6<Self extends Element>(this: Self): Self;
    m_6<Self extends Element>(this: Self): Self;
    m_64<Self extends Element>(this: Self): Self;
    m_7<Self extends Element>(this: Self): Self;
    m_72<Self extends Element>(this: Self): Self;
    m_8<Self extends Element>(this: Self): Self;
    m_80<Self extends Element>(this: Self): Self;
    m_9<Self extends Element>(this: Self): Self;
    m_96<Self extends Element>(this: Self): Self;
    m_auto<Self extends Element>(this: Self): Self;
    m_full<Self extends Element>(this: Self): Self;
    m_neg_0<Self extends Element>(this: Self): Self;
    m_neg_0p5<Self extends Element>(this: Self): Self;
    m_neg_1<Self extends Element>(this: Self): Self;
    m_neg_10<Self extends Element>(this: Self): Self;
    m_neg_11<Self extends Element>(this: Self): Self;
    m_neg_112<Self extends Element>(this: Self): Self;
    m_neg_12<Self extends Element>(this: Self): Self;
    m_neg_128<Self extends Element>(this: Self): Self;
    m_neg_16<Self extends Element>(this: Self): Self;
    m_neg_1_12<Self extends Element>(this: Self): Self;
    m_neg_1_2<Self extends Element>(this: Self): Self;
    m_neg_1_3<Self extends Element>(this: Self): Self;
    m_neg_1_4<Self extends Element>(this: Self): Self;
    m_neg_1_5<Self extends Element>(this: Self): Self;
    m_neg_1_6<Self extends Element>(this: Self): Self;
    m_neg_1p5<Self extends Element>(this: Self): Self;
    m_neg_2<Self extends Element>(this: Self): Self;
    m_neg_20<Self extends Element>(this: Self): Self;
    m_neg_24<Self extends Element>(this: Self): Self;
    m_neg_2_3<Self extends Element>(this: Self): Self;
    m_neg_2_4<Self extends Element>(this: Self): Self;
    m_neg_2_5<Self extends Element>(this: Self): Self;
    m_neg_2p5<Self extends Element>(this: Self): Self;
    m_neg_3<Self extends Element>(this: Self): Self;
    m_neg_32<Self extends Element>(this: Self): Self;
    m_neg_3_4<Self extends Element>(this: Self): Self;
    m_neg_3_5<Self extends Element>(this: Self): Self;
    m_neg_3p5<Self extends Element>(this: Self): Self;
    m_neg_4<Self extends Element>(this: Self): Self;
    m_neg_40<Self extends Element>(this: Self): Self;
    m_neg_48<Self extends Element>(this: Self): Self;
    m_neg_4_5<Self extends Element>(this: Self): Self;
    m_neg_5<Self extends Element>(this: Self): Self;
    m_neg_56<Self extends Element>(this: Self): Self;
    m_neg_5_6<Self extends Element>(this: Self): Self;
    m_neg_6<Self extends Element>(this: Self): Self;
    m_neg_64<Self extends Element>(this: Self): Self;
    m_neg_7<Self extends Element>(this: Self): Self;
    m_neg_72<Self extends Element>(this: Self): Self;
    m_neg_8<Self extends Element>(this: Self): Self;
    m_neg_80<Self extends Element>(this: Self): Self;
    m_neg_9<Self extends Element>(this: Self): Self;
    m_neg_96<Self extends Element>(this: Self): Self;
    m_neg_full<Self extends Element>(this: Self): Self;
    m_neg_px<Self extends Element>(this: Self): Self;
    m_px<Self extends Element>(this: Self): Self;
    max_h_0<Self extends Element>(this: Self): Self;
    max_h_0p5<Self extends Element>(this: Self): Self;
    max_h_1<Self extends Element>(this: Self): Self;
    max_h_10<Self extends Element>(this: Self): Self;
    max_h_11<Self extends Element>(this: Self): Self;
    max_h_112<Self extends Element>(this: Self): Self;
    max_h_12<Self extends Element>(this: Self): Self;
    max_h_128<Self extends Element>(this: Self): Self;
    max_h_16<Self extends Element>(this: Self): Self;
    max_h_1_12<Self extends Element>(this: Self): Self;
    max_h_1_2<Self extends Element>(this: Self): Self;
    max_h_1_3<Self extends Element>(this: Self): Self;
    max_h_1_4<Self extends Element>(this: Self): Self;
    max_h_1_5<Self extends Element>(this: Self): Self;
    max_h_1_6<Self extends Element>(this: Self): Self;
    max_h_1p5<Self extends Element>(this: Self): Self;
    max_h_2<Self extends Element>(this: Self): Self;
    max_h_20<Self extends Element>(this: Self): Self;
    max_h_24<Self extends Element>(this: Self): Self;
    max_h_2_3<Self extends Element>(this: Self): Self;
    max_h_2_4<Self extends Element>(this: Self): Self;
    max_h_2_5<Self extends Element>(this: Self): Self;
    max_h_2p5<Self extends Element>(this: Self): Self;
    max_h_3<Self extends Element>(this: Self): Self;
    max_h_32<Self extends Element>(this: Self): Self;
    max_h_3_4<Self extends Element>(this: Self): Self;
    max_h_3_5<Self extends Element>(this: Self): Self;
    max_h_3p5<Self extends Element>(this: Self): Self;
    max_h_4<Self extends Element>(this: Self): Self;
    max_h_40<Self extends Element>(this: Self): Self;
    max_h_48<Self extends Element>(this: Self): Self;
    max_h_4_5<Self extends Element>(this: Self): Self;
    max_h_5<Self extends Element>(this: Self): Self;
    max_h_56<Self extends Element>(this: Self): Self;
    max_h_5_6<Self extends Element>(this: Self): Self;
    max_h_6<Self extends Element>(this: Self): Self;
    max_h_64<Self extends Element>(this: Self): Self;
    max_h_7<Self extends Element>(this: Self): Self;
    max_h_72<Self extends Element>(this: Self): Self;
    max_h_8<Self extends Element>(this: Self): Self;
    max_h_80<Self extends Element>(this: Self): Self;
    max_h_9<Self extends Element>(this: Self): Self;
    max_h_96<Self extends Element>(this: Self): Self;
    max_h_auto<Self extends Element>(this: Self): Self;
    max_h_full<Self extends Element>(this: Self): Self;
    max_h_neg_0<Self extends Element>(this: Self): Self;
    max_h_neg_0p5<Self extends Element>(this: Self): Self;
    max_h_neg_1<Self extends Element>(this: Self): Self;
    max_h_neg_10<Self extends Element>(this: Self): Self;
    max_h_neg_11<Self extends Element>(this: Self): Self;
    max_h_neg_112<Self extends Element>(this: Self): Self;
    max_h_neg_12<Self extends Element>(this: Self): Self;
    max_h_neg_128<Self extends Element>(this: Self): Self;
    max_h_neg_16<Self extends Element>(this: Self): Self;
    max_h_neg_1_12<Self extends Element>(this: Self): Self;
    max_h_neg_1_2<Self extends Element>(this: Self): Self;
    max_h_neg_1_3<Self extends Element>(this: Self): Self;
    max_h_neg_1_4<Self extends Element>(this: Self): Self;
    max_h_neg_1_5<Self extends Element>(this: Self): Self;
    max_h_neg_1_6<Self extends Element>(this: Self): Self;
    max_h_neg_1p5<Self extends Element>(this: Self): Self;
    max_h_neg_2<Self extends Element>(this: Self): Self;
    max_h_neg_20<Self extends Element>(this: Self): Self;
    max_h_neg_24<Self extends Element>(this: Self): Self;
    max_h_neg_2_3<Self extends Element>(this: Self): Self;
    max_h_neg_2_4<Self extends Element>(this: Self): Self;
    max_h_neg_2_5<Self extends Element>(this: Self): Self;
    max_h_neg_2p5<Self extends Element>(this: Self): Self;
    max_h_neg_3<Self extends Element>(this: Self): Self;
    max_h_neg_32<Self extends Element>(this: Self): Self;
    max_h_neg_3_4<Self extends Element>(this: Self): Self;
    max_h_neg_3_5<Self extends Element>(this: Self): Self;
    max_h_neg_3p5<Self extends Element>(this: Self): Self;
    max_h_neg_4<Self extends Element>(this: Self): Self;
    max_h_neg_40<Self extends Element>(this: Self): Self;
    max_h_neg_48<Self extends Element>(this: Self): Self;
    max_h_neg_4_5<Self extends Element>(this: Self): Self;
    max_h_neg_5<Self extends Element>(this: Self): Self;
    max_h_neg_56<Self extends Element>(this: Self): Self;
    max_h_neg_5_6<Self extends Element>(this: Self): Self;
    max_h_neg_6<Self extends Element>(this: Self): Self;
    max_h_neg_64<Self extends Element>(this: Self): Self;
    max_h_neg_7<Self extends Element>(this: Self): Self;
    max_h_neg_72<Self extends Element>(this: Self): Self;
    max_h_neg_8<Self extends Element>(this: Self): Self;
    max_h_neg_80<Self extends Element>(this: Self): Self;
    max_h_neg_9<Self extends Element>(this: Self): Self;
    max_h_neg_96<Self extends Element>(this: Self): Self;
    max_h_neg_full<Self extends Element>(this: Self): Self;
    max_h_neg_px<Self extends Element>(this: Self): Self;
    max_h_px<Self extends Element>(this: Self): Self;
    max_size_0<Self extends Element>(this: Self): Self;
    max_size_0p5<Self extends Element>(this: Self): Self;
    max_size_1<Self extends Element>(this: Self): Self;
    max_size_10<Self extends Element>(this: Self): Self;
    max_size_11<Self extends Element>(this: Self): Self;
    max_size_112<Self extends Element>(this: Self): Self;
    max_size_12<Self extends Element>(this: Self): Self;
    max_size_128<Self extends Element>(this: Self): Self;
    max_size_16<Self extends Element>(this: Self): Self;
    max_size_1_12<Self extends Element>(this: Self): Self;
    max_size_1_2<Self extends Element>(this: Self): Self;
    max_size_1_3<Self extends Element>(this: Self): Self;
    max_size_1_4<Self extends Element>(this: Self): Self;
    max_size_1_5<Self extends Element>(this: Self): Self;
    max_size_1_6<Self extends Element>(this: Self): Self;
    max_size_1p5<Self extends Element>(this: Self): Self;
    max_size_2<Self extends Element>(this: Self): Self;
    max_size_20<Self extends Element>(this: Self): Self;
    max_size_24<Self extends Element>(this: Self): Self;
    max_size_2_3<Self extends Element>(this: Self): Self;
    max_size_2_4<Self extends Element>(this: Self): Self;
    max_size_2_5<Self extends Element>(this: Self): Self;
    max_size_2p5<Self extends Element>(this: Self): Self;
    max_size_3<Self extends Element>(this: Self): Self;
    max_size_32<Self extends Element>(this: Self): Self;
    max_size_3_4<Self extends Element>(this: Self): Self;
    max_size_3_5<Self extends Element>(this: Self): Self;
    max_size_3p5<Self extends Element>(this: Self): Self;
    max_size_4<Self extends Element>(this: Self): Self;
    max_size_40<Self extends Element>(this: Self): Self;
    max_size_48<Self extends Element>(this: Self): Self;
    max_size_4_5<Self extends Element>(this: Self): Self;
    max_size_5<Self extends Element>(this: Self): Self;
    max_size_56<Self extends Element>(this: Self): Self;
    max_size_5_6<Self extends Element>(this: Self): Self;
    max_size_6<Self extends Element>(this: Self): Self;
    max_size_64<Self extends Element>(this: Self): Self;
    max_size_7<Self extends Element>(this: Self): Self;
    max_size_72<Self extends Element>(this: Self): Self;
    max_size_8<Self extends Element>(this: Self): Self;
    max_size_80<Self extends Element>(this: Self): Self;
    max_size_9<Self extends Element>(this: Self): Self;
    max_size_96<Self extends Element>(this: Self): Self;
    max_size_auto<Self extends Element>(this: Self): Self;
    max_size_full<Self extends Element>(this: Self): Self;
    max_size_neg_0<Self extends Element>(this: Self): Self;
    max_size_neg_0p5<Self extends Element>(this: Self): Self;
    max_size_neg_1<Self extends Element>(this: Self): Self;
    max_size_neg_10<Self extends Element>(this: Self): Self;
    max_size_neg_11<Self extends Element>(this: Self): Self;
    max_size_neg_112<Self extends Element>(this: Self): Self;
    max_size_neg_12<Self extends Element>(this: Self): Self;
    max_size_neg_128<Self extends Element>(this: Self): Self;
    max_size_neg_16<Self extends Element>(this: Self): Self;
    max_size_neg_1_12<Self extends Element>(this: Self): Self;
    max_size_neg_1_2<Self extends Element>(this: Self): Self;
    max_size_neg_1_3<Self extends Element>(this: Self): Self;
    max_size_neg_1_4<Self extends Element>(this: Self): Self;
    max_size_neg_1_5<Self extends Element>(this: Self): Self;
    max_size_neg_1_6<Self extends Element>(this: Self): Self;
    max_size_neg_1p5<Self extends Element>(this: Self): Self;
    max_size_neg_2<Self extends Element>(this: Self): Self;
    max_size_neg_20<Self extends Element>(this: Self): Self;
    max_size_neg_24<Self extends Element>(this: Self): Self;
    max_size_neg_2_3<Self extends Element>(this: Self): Self;
    max_size_neg_2_4<Self extends Element>(this: Self): Self;
    max_size_neg_2_5<Self extends Element>(this: Self): Self;
    max_size_neg_2p5<Self extends Element>(this: Self): Self;
    max_size_neg_3<Self extends Element>(this: Self): Self;
    max_size_neg_32<Self extends Element>(this: Self): Self;
    max_size_neg_3_4<Self extends Element>(this: Self): Self;
    max_size_neg_3_5<Self extends Element>(this: Self): Self;
    max_size_neg_3p5<Self extends Element>(this: Self): Self;
    max_size_neg_4<Self extends Element>(this: Self): Self;
    max_size_neg_40<Self extends Element>(this: Self): Self;
    max_size_neg_48<Self extends Element>(this: Self): Self;
    max_size_neg_4_5<Self extends Element>(this: Self): Self;
    max_size_neg_5<Self extends Element>(this: Self): Self;
    max_size_neg_56<Self extends Element>(this: Self): Self;
    max_size_neg_5_6<Self extends Element>(this: Self): Self;
    max_size_neg_6<Self extends Element>(this: Self): Self;
    max_size_neg_64<Self extends Element>(this: Self): Self;
    max_size_neg_7<Self extends Element>(this: Self): Self;
    max_size_neg_72<Self extends Element>(this: Self): Self;
    max_size_neg_8<Self extends Element>(this: Self): Self;
    max_size_neg_80<Self extends Element>(this: Self): Self;
    max_size_neg_9<Self extends Element>(this: Self): Self;
    max_size_neg_96<Self extends Element>(this: Self): Self;
    max_size_neg_full<Self extends Element>(this: Self): Self;
    max_size_neg_px<Self extends Element>(this: Self): Self;
    max_size_px<Self extends Element>(this: Self): Self;
    max_w_0<Self extends Element>(this: Self): Self;
    max_w_0p5<Self extends Element>(this: Self): Self;
    max_w_1<Self extends Element>(this: Self): Self;
    max_w_10<Self extends Element>(this: Self): Self;
    max_w_11<Self extends Element>(this: Self): Self;
    max_w_112<Self extends Element>(this: Self): Self;
    max_w_12<Self extends Element>(this: Self): Self;
    max_w_128<Self extends Element>(this: Self): Self;
    max_w_16<Self extends Element>(this: Self): Self;
    max_w_1_12<Self extends Element>(this: Self): Self;
    max_w_1_2<Self extends Element>(this: Self): Self;
    max_w_1_3<Self extends Element>(this: Self): Self;
    max_w_1_4<Self extends Element>(this: Self): Self;
    max_w_1_5<Self extends Element>(this: Self): Self;
    max_w_1_6<Self extends Element>(this: Self): Self;
    max_w_1p5<Self extends Element>(this: Self): Self;
    max_w_2<Self extends Element>(this: Self): Self;
    max_w_20<Self extends Element>(this: Self): Self;
    max_w_24<Self extends Element>(this: Self): Self;
    max_w_2_3<Self extends Element>(this: Self): Self;
    max_w_2_4<Self extends Element>(this: Self): Self;
    max_w_2_5<Self extends Element>(this: Self): Self;
    max_w_2p5<Self extends Element>(this: Self): Self;
    max_w_3<Self extends Element>(this: Self): Self;
    max_w_32<Self extends Element>(this: Self): Self;
    max_w_3_4<Self extends Element>(this: Self): Self;
    max_w_3_5<Self extends Element>(this: Self): Self;
    max_w_3p5<Self extends Element>(this: Self): Self;
    max_w_4<Self extends Element>(this: Self): Self;
    max_w_40<Self extends Element>(this: Self): Self;
    max_w_48<Self extends Element>(this: Self): Self;
    max_w_4_5<Self extends Element>(this: Self): Self;
    max_w_5<Self extends Element>(this: Self): Self;
    max_w_56<Self extends Element>(this: Self): Self;
    max_w_5_6<Self extends Element>(this: Self): Self;
    max_w_6<Self extends Element>(this: Self): Self;
    max_w_64<Self extends Element>(this: Self): Self;
    max_w_7<Self extends Element>(this: Self): Self;
    max_w_72<Self extends Element>(this: Self): Self;
    max_w_8<Self extends Element>(this: Self): Self;
    max_w_80<Self extends Element>(this: Self): Self;
    max_w_9<Self extends Element>(this: Self): Self;
    max_w_96<Self extends Element>(this: Self): Self;
    max_w_auto<Self extends Element>(this: Self): Self;
    max_w_full<Self extends Element>(this: Self): Self;
    max_w_neg_0<Self extends Element>(this: Self): Self;
    max_w_neg_0p5<Self extends Element>(this: Self): Self;
    max_w_neg_1<Self extends Element>(this: Self): Self;
    max_w_neg_10<Self extends Element>(this: Self): Self;
    max_w_neg_11<Self extends Element>(this: Self): Self;
    max_w_neg_112<Self extends Element>(this: Self): Self;
    max_w_neg_12<Self extends Element>(this: Self): Self;
    max_w_neg_128<Self extends Element>(this: Self): Self;
    max_w_neg_16<Self extends Element>(this: Self): Self;
    max_w_neg_1_12<Self extends Element>(this: Self): Self;
    max_w_neg_1_2<Self extends Element>(this: Self): Self;
    max_w_neg_1_3<Self extends Element>(this: Self): Self;
    max_w_neg_1_4<Self extends Element>(this: Self): Self;
    max_w_neg_1_5<Self extends Element>(this: Self): Self;
    max_w_neg_1_6<Self extends Element>(this: Self): Self;
    max_w_neg_1p5<Self extends Element>(this: Self): Self;
    max_w_neg_2<Self extends Element>(this: Self): Self;
    max_w_neg_20<Self extends Element>(this: Self): Self;
    max_w_neg_24<Self extends Element>(this: Self): Self;
    max_w_neg_2_3<Self extends Element>(this: Self): Self;
    max_w_neg_2_4<Self extends Element>(this: Self): Self;
    max_w_neg_2_5<Self extends Element>(this: Self): Self;
    max_w_neg_2p5<Self extends Element>(this: Self): Self;
    max_w_neg_3<Self extends Element>(this: Self): Self;
    max_w_neg_32<Self extends Element>(this: Self): Self;
    max_w_neg_3_4<Self extends Element>(this: Self): Self;
    max_w_neg_3_5<Self extends Element>(this: Self): Self;
    max_w_neg_3p5<Self extends Element>(this: Self): Self;
    max_w_neg_4<Self extends Element>(this: Self): Self;
    max_w_neg_40<Self extends Element>(this: Self): Self;
    max_w_neg_48<Self extends Element>(this: Self): Self;
    max_w_neg_4_5<Self extends Element>(this: Self): Self;
    max_w_neg_5<Self extends Element>(this: Self): Self;
    max_w_neg_56<Self extends Element>(this: Self): Self;
    max_w_neg_5_6<Self extends Element>(this: Self): Self;
    max_w_neg_6<Self extends Element>(this: Self): Self;
    max_w_neg_64<Self extends Element>(this: Self): Self;
    max_w_neg_7<Self extends Element>(this: Self): Self;
    max_w_neg_72<Self extends Element>(this: Self): Self;
    max_w_neg_8<Self extends Element>(this: Self): Self;
    max_w_neg_80<Self extends Element>(this: Self): Self;
    max_w_neg_9<Self extends Element>(this: Self): Self;
    max_w_neg_96<Self extends Element>(this: Self): Self;
    max_w_neg_full<Self extends Element>(this: Self): Self;
    max_w_neg_px<Self extends Element>(this: Self): Self;
    max_w_px<Self extends Element>(this: Self): Self;
    mb_0<Self extends Element>(this: Self): Self;
    mb_0p5<Self extends Element>(this: Self): Self;
    mb_1<Self extends Element>(this: Self): Self;
    mb_10<Self extends Element>(this: Self): Self;
    mb_11<Self extends Element>(this: Self): Self;
    mb_112<Self extends Element>(this: Self): Self;
    mb_12<Self extends Element>(this: Self): Self;
    mb_128<Self extends Element>(this: Self): Self;
    mb_16<Self extends Element>(this: Self): Self;
    mb_1_12<Self extends Element>(this: Self): Self;
    mb_1_2<Self extends Element>(this: Self): Self;
    mb_1_3<Self extends Element>(this: Self): Self;
    mb_1_4<Self extends Element>(this: Self): Self;
    mb_1_5<Self extends Element>(this: Self): Self;
    mb_1_6<Self extends Element>(this: Self): Self;
    mb_1p5<Self extends Element>(this: Self): Self;
    mb_2<Self extends Element>(this: Self): Self;
    mb_20<Self extends Element>(this: Self): Self;
    mb_24<Self extends Element>(this: Self): Self;
    mb_2_3<Self extends Element>(this: Self): Self;
    mb_2_4<Self extends Element>(this: Self): Self;
    mb_2_5<Self extends Element>(this: Self): Self;
    mb_2p5<Self extends Element>(this: Self): Self;
    mb_3<Self extends Element>(this: Self): Self;
    mb_32<Self extends Element>(this: Self): Self;
    mb_3_4<Self extends Element>(this: Self): Self;
    mb_3_5<Self extends Element>(this: Self): Self;
    mb_3p5<Self extends Element>(this: Self): Self;
    mb_4<Self extends Element>(this: Self): Self;
    mb_40<Self extends Element>(this: Self): Self;
    mb_48<Self extends Element>(this: Self): Self;
    mb_4_5<Self extends Element>(this: Self): Self;
    mb_5<Self extends Element>(this: Self): Self;
    mb_56<Self extends Element>(this: Self): Self;
    mb_5_6<Self extends Element>(this: Self): Self;
    mb_6<Self extends Element>(this: Self): Self;
    mb_64<Self extends Element>(this: Self): Self;
    mb_7<Self extends Element>(this: Self): Self;
    mb_72<Self extends Element>(this: Self): Self;
    mb_8<Self extends Element>(this: Self): Self;
    mb_80<Self extends Element>(this: Self): Self;
    mb_9<Self extends Element>(this: Self): Self;
    mb_96<Self extends Element>(this: Self): Self;
    mb_auto<Self extends Element>(this: Self): Self;
    mb_full<Self extends Element>(this: Self): Self;
    mb_neg_0<Self extends Element>(this: Self): Self;
    mb_neg_0p5<Self extends Element>(this: Self): Self;
    mb_neg_1<Self extends Element>(this: Self): Self;
    mb_neg_10<Self extends Element>(this: Self): Self;
    mb_neg_11<Self extends Element>(this: Self): Self;
    mb_neg_112<Self extends Element>(this: Self): Self;
    mb_neg_12<Self extends Element>(this: Self): Self;
    mb_neg_128<Self extends Element>(this: Self): Self;
    mb_neg_16<Self extends Element>(this: Self): Self;
    mb_neg_1_12<Self extends Element>(this: Self): Self;
    mb_neg_1_2<Self extends Element>(this: Self): Self;
    mb_neg_1_3<Self extends Element>(this: Self): Self;
    mb_neg_1_4<Self extends Element>(this: Self): Self;
    mb_neg_1_5<Self extends Element>(this: Self): Self;
    mb_neg_1_6<Self extends Element>(this: Self): Self;
    mb_neg_1p5<Self extends Element>(this: Self): Self;
    mb_neg_2<Self extends Element>(this: Self): Self;
    mb_neg_20<Self extends Element>(this: Self): Self;
    mb_neg_24<Self extends Element>(this: Self): Self;
    mb_neg_2_3<Self extends Element>(this: Self): Self;
    mb_neg_2_4<Self extends Element>(this: Self): Self;
    mb_neg_2_5<Self extends Element>(this: Self): Self;
    mb_neg_2p5<Self extends Element>(this: Self): Self;
    mb_neg_3<Self extends Element>(this: Self): Self;
    mb_neg_32<Self extends Element>(this: Self): Self;
    mb_neg_3_4<Self extends Element>(this: Self): Self;
    mb_neg_3_5<Self extends Element>(this: Self): Self;
    mb_neg_3p5<Self extends Element>(this: Self): Self;
    mb_neg_4<Self extends Element>(this: Self): Self;
    mb_neg_40<Self extends Element>(this: Self): Self;
    mb_neg_48<Self extends Element>(this: Self): Self;
    mb_neg_4_5<Self extends Element>(this: Self): Self;
    mb_neg_5<Self extends Element>(this: Self): Self;
    mb_neg_56<Self extends Element>(this: Self): Self;
    mb_neg_5_6<Self extends Element>(this: Self): Self;
    mb_neg_6<Self extends Element>(this: Self): Self;
    mb_neg_64<Self extends Element>(this: Self): Self;
    mb_neg_7<Self extends Element>(this: Self): Self;
    mb_neg_72<Self extends Element>(this: Self): Self;
    mb_neg_8<Self extends Element>(this: Self): Self;
    mb_neg_80<Self extends Element>(this: Self): Self;
    mb_neg_9<Self extends Element>(this: Self): Self;
    mb_neg_96<Self extends Element>(this: Self): Self;
    mb_neg_full<Self extends Element>(this: Self): Self;
    mb_neg_px<Self extends Element>(this: Self): Self;
    mb_px<Self extends Element>(this: Self): Self;
    min_h_0<Self extends Element>(this: Self): Self;
    min_h_0p5<Self extends Element>(this: Self): Self;
    min_h_1<Self extends Element>(this: Self): Self;
    min_h_10<Self extends Element>(this: Self): Self;
    min_h_11<Self extends Element>(this: Self): Self;
    min_h_112<Self extends Element>(this: Self): Self;
    min_h_12<Self extends Element>(this: Self): Self;
    min_h_128<Self extends Element>(this: Self): Self;
    min_h_16<Self extends Element>(this: Self): Self;
    min_h_1_12<Self extends Element>(this: Self): Self;
    min_h_1_2<Self extends Element>(this: Self): Self;
    min_h_1_3<Self extends Element>(this: Self): Self;
    min_h_1_4<Self extends Element>(this: Self): Self;
    min_h_1_5<Self extends Element>(this: Self): Self;
    min_h_1_6<Self extends Element>(this: Self): Self;
    min_h_1p5<Self extends Element>(this: Self): Self;
    min_h_2<Self extends Element>(this: Self): Self;
    min_h_20<Self extends Element>(this: Self): Self;
    min_h_24<Self extends Element>(this: Self): Self;
    min_h_2_3<Self extends Element>(this: Self): Self;
    min_h_2_4<Self extends Element>(this: Self): Self;
    min_h_2_5<Self extends Element>(this: Self): Self;
    min_h_2p5<Self extends Element>(this: Self): Self;
    min_h_3<Self extends Element>(this: Self): Self;
    min_h_32<Self extends Element>(this: Self): Self;
    min_h_3_4<Self extends Element>(this: Self): Self;
    min_h_3_5<Self extends Element>(this: Self): Self;
    min_h_3p5<Self extends Element>(this: Self): Self;
    min_h_4<Self extends Element>(this: Self): Self;
    min_h_40<Self extends Element>(this: Self): Self;
    min_h_48<Self extends Element>(this: Self): Self;
    min_h_4_5<Self extends Element>(this: Self): Self;
    min_h_5<Self extends Element>(this: Self): Self;
    min_h_56<Self extends Element>(this: Self): Self;
    min_h_5_6<Self extends Element>(this: Self): Self;
    min_h_6<Self extends Element>(this: Self): Self;
    min_h_64<Self extends Element>(this: Self): Self;
    min_h_7<Self extends Element>(this: Self): Self;
    min_h_72<Self extends Element>(this: Self): Self;
    min_h_8<Self extends Element>(this: Self): Self;
    min_h_80<Self extends Element>(this: Self): Self;
    min_h_9<Self extends Element>(this: Self): Self;
    min_h_96<Self extends Element>(this: Self): Self;
    min_h_auto<Self extends Element>(this: Self): Self;
    min_h_full<Self extends Element>(this: Self): Self;
    min_h_neg_0<Self extends Element>(this: Self): Self;
    min_h_neg_0p5<Self extends Element>(this: Self): Self;
    min_h_neg_1<Self extends Element>(this: Self): Self;
    min_h_neg_10<Self extends Element>(this: Self): Self;
    min_h_neg_11<Self extends Element>(this: Self): Self;
    min_h_neg_112<Self extends Element>(this: Self): Self;
    min_h_neg_12<Self extends Element>(this: Self): Self;
    min_h_neg_128<Self extends Element>(this: Self): Self;
    min_h_neg_16<Self extends Element>(this: Self): Self;
    min_h_neg_1_12<Self extends Element>(this: Self): Self;
    min_h_neg_1_2<Self extends Element>(this: Self): Self;
    min_h_neg_1_3<Self extends Element>(this: Self): Self;
    min_h_neg_1_4<Self extends Element>(this: Self): Self;
    min_h_neg_1_5<Self extends Element>(this: Self): Self;
    min_h_neg_1_6<Self extends Element>(this: Self): Self;
    min_h_neg_1p5<Self extends Element>(this: Self): Self;
    min_h_neg_2<Self extends Element>(this: Self): Self;
    min_h_neg_20<Self extends Element>(this: Self): Self;
    min_h_neg_24<Self extends Element>(this: Self): Self;
    min_h_neg_2_3<Self extends Element>(this: Self): Self;
    min_h_neg_2_4<Self extends Element>(this: Self): Self;
    min_h_neg_2_5<Self extends Element>(this: Self): Self;
    min_h_neg_2p5<Self extends Element>(this: Self): Self;
    min_h_neg_3<Self extends Element>(this: Self): Self;
    min_h_neg_32<Self extends Element>(this: Self): Self;
    min_h_neg_3_4<Self extends Element>(this: Self): Self;
    min_h_neg_3_5<Self extends Element>(this: Self): Self;
    min_h_neg_3p5<Self extends Element>(this: Self): Self;
    min_h_neg_4<Self extends Element>(this: Self): Self;
    min_h_neg_40<Self extends Element>(this: Self): Self;
    min_h_neg_48<Self extends Element>(this: Self): Self;
    min_h_neg_4_5<Self extends Element>(this: Self): Self;
    min_h_neg_5<Self extends Element>(this: Self): Self;
    min_h_neg_56<Self extends Element>(this: Self): Self;
    min_h_neg_5_6<Self extends Element>(this: Self): Self;
    min_h_neg_6<Self extends Element>(this: Self): Self;
    min_h_neg_64<Self extends Element>(this: Self): Self;
    min_h_neg_7<Self extends Element>(this: Self): Self;
    min_h_neg_72<Self extends Element>(this: Self): Self;
    min_h_neg_8<Self extends Element>(this: Self): Self;
    min_h_neg_80<Self extends Element>(this: Self): Self;
    min_h_neg_9<Self extends Element>(this: Self): Self;
    min_h_neg_96<Self extends Element>(this: Self): Self;
    min_h_neg_full<Self extends Element>(this: Self): Self;
    min_h_neg_px<Self extends Element>(this: Self): Self;
    min_h_px<Self extends Element>(this: Self): Self;
    min_size_0<Self extends Element>(this: Self): Self;
    min_size_0p5<Self extends Element>(this: Self): Self;
    min_size_1<Self extends Element>(this: Self): Self;
    min_size_10<Self extends Element>(this: Self): Self;
    min_size_11<Self extends Element>(this: Self): Self;
    min_size_112<Self extends Element>(this: Self): Self;
    min_size_12<Self extends Element>(this: Self): Self;
    min_size_128<Self extends Element>(this: Self): Self;
    min_size_16<Self extends Element>(this: Self): Self;
    min_size_1_12<Self extends Element>(this: Self): Self;
    min_size_1_2<Self extends Element>(this: Self): Self;
    min_size_1_3<Self extends Element>(this: Self): Self;
    min_size_1_4<Self extends Element>(this: Self): Self;
    min_size_1_5<Self extends Element>(this: Self): Self;
    min_size_1_6<Self extends Element>(this: Self): Self;
    min_size_1p5<Self extends Element>(this: Self): Self;
    min_size_2<Self extends Element>(this: Self): Self;
    min_size_20<Self extends Element>(this: Self): Self;
    min_size_24<Self extends Element>(this: Self): Self;
    min_size_2_3<Self extends Element>(this: Self): Self;
    min_size_2_4<Self extends Element>(this: Self): Self;
    min_size_2_5<Self extends Element>(this: Self): Self;
    min_size_2p5<Self extends Element>(this: Self): Self;
    min_size_3<Self extends Element>(this: Self): Self;
    min_size_32<Self extends Element>(this: Self): Self;
    min_size_3_4<Self extends Element>(this: Self): Self;
    min_size_3_5<Self extends Element>(this: Self): Self;
    min_size_3p5<Self extends Element>(this: Self): Self;
    min_size_4<Self extends Element>(this: Self): Self;
    min_size_40<Self extends Element>(this: Self): Self;
    min_size_48<Self extends Element>(this: Self): Self;
    min_size_4_5<Self extends Element>(this: Self): Self;
    min_size_5<Self extends Element>(this: Self): Self;
    min_size_56<Self extends Element>(this: Self): Self;
    min_size_5_6<Self extends Element>(this: Self): Self;
    min_size_6<Self extends Element>(this: Self): Self;
    min_size_64<Self extends Element>(this: Self): Self;
    min_size_7<Self extends Element>(this: Self): Self;
    min_size_72<Self extends Element>(this: Self): Self;
    min_size_8<Self extends Element>(this: Self): Self;
    min_size_80<Self extends Element>(this: Self): Self;
    min_size_9<Self extends Element>(this: Self): Self;
    min_size_96<Self extends Element>(this: Self): Self;
    min_size_auto<Self extends Element>(this: Self): Self;
    min_size_full<Self extends Element>(this: Self): Self;
    min_size_neg_0<Self extends Element>(this: Self): Self;
    min_size_neg_0p5<Self extends Element>(this: Self): Self;
    min_size_neg_1<Self extends Element>(this: Self): Self;
    min_size_neg_10<Self extends Element>(this: Self): Self;
    min_size_neg_11<Self extends Element>(this: Self): Self;
    min_size_neg_112<Self extends Element>(this: Self): Self;
    min_size_neg_12<Self extends Element>(this: Self): Self;
    min_size_neg_128<Self extends Element>(this: Self): Self;
    min_size_neg_16<Self extends Element>(this: Self): Self;
    min_size_neg_1_12<Self extends Element>(this: Self): Self;
    min_size_neg_1_2<Self extends Element>(this: Self): Self;
    min_size_neg_1_3<Self extends Element>(this: Self): Self;
    min_size_neg_1_4<Self extends Element>(this: Self): Self;
    min_size_neg_1_5<Self extends Element>(this: Self): Self;
    min_size_neg_1_6<Self extends Element>(this: Self): Self;
    min_size_neg_1p5<Self extends Element>(this: Self): Self;
    min_size_neg_2<Self extends Element>(this: Self): Self;
    min_size_neg_20<Self extends Element>(this: Self): Self;
    min_size_neg_24<Self extends Element>(this: Self): Self;
    min_size_neg_2_3<Self extends Element>(this: Self): Self;
    min_size_neg_2_4<Self extends Element>(this: Self): Self;
    min_size_neg_2_5<Self extends Element>(this: Self): Self;
    min_size_neg_2p5<Self extends Element>(this: Self): Self;
    min_size_neg_3<Self extends Element>(this: Self): Self;
    min_size_neg_32<Self extends Element>(this: Self): Self;
    min_size_neg_3_4<Self extends Element>(this: Self): Self;
    min_size_neg_3_5<Self extends Element>(this: Self): Self;
    min_size_neg_3p5<Self extends Element>(this: Self): Self;
    min_size_neg_4<Self extends Element>(this: Self): Self;
    min_size_neg_40<Self extends Element>(this: Self): Self;
    min_size_neg_48<Self extends Element>(this: Self): Self;
    min_size_neg_4_5<Self extends Element>(this: Self): Self;
    min_size_neg_5<Self extends Element>(this: Self): Self;
    min_size_neg_56<Self extends Element>(this: Self): Self;
    min_size_neg_5_6<Self extends Element>(this: Self): Self;
    min_size_neg_6<Self extends Element>(this: Self): Self;
    min_size_neg_64<Self extends Element>(this: Self): Self;
    min_size_neg_7<Self extends Element>(this: Self): Self;
    min_size_neg_72<Self extends Element>(this: Self): Self;
    min_size_neg_8<Self extends Element>(this: Self): Self;
    min_size_neg_80<Self extends Element>(this: Self): Self;
    min_size_neg_9<Self extends Element>(this: Self): Self;
    min_size_neg_96<Self extends Element>(this: Self): Self;
    min_size_neg_full<Self extends Element>(this: Self): Self;
    min_size_neg_px<Self extends Element>(this: Self): Self;
    min_size_px<Self extends Element>(this: Self): Self;
    min_w_0<Self extends Element>(this: Self): Self;
    min_w_0p5<Self extends Element>(this: Self): Self;
    min_w_1<Self extends Element>(this: Self): Self;
    min_w_10<Self extends Element>(this: Self): Self;
    min_w_11<Self extends Element>(this: Self): Self;
    min_w_112<Self extends Element>(this: Self): Self;
    min_w_12<Self extends Element>(this: Self): Self;
    min_w_128<Self extends Element>(this: Self): Self;
    min_w_16<Self extends Element>(this: Self): Self;
    min_w_1_12<Self extends Element>(this: Self): Self;
    min_w_1_2<Self extends Element>(this: Self): Self;
    min_w_1_3<Self extends Element>(this: Self): Self;
    min_w_1_4<Self extends Element>(this: Self): Self;
    min_w_1_5<Self extends Element>(this: Self): Self;
    min_w_1_6<Self extends Element>(this: Self): Self;
    min_w_1p5<Self extends Element>(this: Self): Self;
    min_w_2<Self extends Element>(this: Self): Self;
    min_w_20<Self extends Element>(this: Self): Self;
    min_w_24<Self extends Element>(this: Self): Self;
    min_w_2_3<Self extends Element>(this: Self): Self;
    min_w_2_4<Self extends Element>(this: Self): Self;
    min_w_2_5<Self extends Element>(this: Self): Self;
    min_w_2p5<Self extends Element>(this: Self): Self;
    min_w_3<Self extends Element>(this: Self): Self;
    min_w_32<Self extends Element>(this: Self): Self;
    min_w_3_4<Self extends Element>(this: Self): Self;
    min_w_3_5<Self extends Element>(this: Self): Self;
    min_w_3p5<Self extends Element>(this: Self): Self;
    min_w_4<Self extends Element>(this: Self): Self;
    min_w_40<Self extends Element>(this: Self): Self;
    min_w_48<Self extends Element>(this: Self): Self;
    min_w_4_5<Self extends Element>(this: Self): Self;
    min_w_5<Self extends Element>(this: Self): Self;
    min_w_56<Self extends Element>(this: Self): Self;
    min_w_5_6<Self extends Element>(this: Self): Self;
    min_w_6<Self extends Element>(this: Self): Self;
    min_w_64<Self extends Element>(this: Self): Self;
    min_w_7<Self extends Element>(this: Self): Self;
    min_w_72<Self extends Element>(this: Self): Self;
    min_w_8<Self extends Element>(this: Self): Self;
    min_w_80<Self extends Element>(this: Self): Self;
    min_w_9<Self extends Element>(this: Self): Self;
    min_w_96<Self extends Element>(this: Self): Self;
    min_w_auto<Self extends Element>(this: Self): Self;
    min_w_full<Self extends Element>(this: Self): Self;
    min_w_neg_0<Self extends Element>(this: Self): Self;
    min_w_neg_0p5<Self extends Element>(this: Self): Self;
    min_w_neg_1<Self extends Element>(this: Self): Self;
    min_w_neg_10<Self extends Element>(this: Self): Self;
    min_w_neg_11<Self extends Element>(this: Self): Self;
    min_w_neg_112<Self extends Element>(this: Self): Self;
    min_w_neg_12<Self extends Element>(this: Self): Self;
    min_w_neg_128<Self extends Element>(this: Self): Self;
    min_w_neg_16<Self extends Element>(this: Self): Self;
    min_w_neg_1_12<Self extends Element>(this: Self): Self;
    min_w_neg_1_2<Self extends Element>(this: Self): Self;
    min_w_neg_1_3<Self extends Element>(this: Self): Self;
    min_w_neg_1_4<Self extends Element>(this: Self): Self;
    min_w_neg_1_5<Self extends Element>(this: Self): Self;
    min_w_neg_1_6<Self extends Element>(this: Self): Self;
    min_w_neg_1p5<Self extends Element>(this: Self): Self;
    min_w_neg_2<Self extends Element>(this: Self): Self;
    min_w_neg_20<Self extends Element>(this: Self): Self;
    min_w_neg_24<Self extends Element>(this: Self): Self;
    min_w_neg_2_3<Self extends Element>(this: Self): Self;
    min_w_neg_2_4<Self extends Element>(this: Self): Self;
    min_w_neg_2_5<Self extends Element>(this: Self): Self;
    min_w_neg_2p5<Self extends Element>(this: Self): Self;
    min_w_neg_3<Self extends Element>(this: Self): Self;
    min_w_neg_32<Self extends Element>(this: Self): Self;
    min_w_neg_3_4<Self extends Element>(this: Self): Self;
    min_w_neg_3_5<Self extends Element>(this: Self): Self;
    min_w_neg_3p5<Self extends Element>(this: Self): Self;
    min_w_neg_4<Self extends Element>(this: Self): Self;
    min_w_neg_40<Self extends Element>(this: Self): Self;
    min_w_neg_48<Self extends Element>(this: Self): Self;
    min_w_neg_4_5<Self extends Element>(this: Self): Self;
    min_w_neg_5<Self extends Element>(this: Self): Self;
    min_w_neg_56<Self extends Element>(this: Self): Self;
    min_w_neg_5_6<Self extends Element>(this: Self): Self;
    min_w_neg_6<Self extends Element>(this: Self): Self;
    min_w_neg_64<Self extends Element>(this: Self): Self;
    min_w_neg_7<Self extends Element>(this: Self): Self;
    min_w_neg_72<Self extends Element>(this: Self): Self;
    min_w_neg_8<Self extends Element>(this: Self): Self;
    min_w_neg_80<Self extends Element>(this: Self): Self;
    min_w_neg_9<Self extends Element>(this: Self): Self;
    min_w_neg_96<Self extends Element>(this: Self): Self;
    min_w_neg_full<Self extends Element>(this: Self): Self;
    min_w_neg_px<Self extends Element>(this: Self): Self;
    min_w_px<Self extends Element>(this: Self): Self;
    ml_0<Self extends Element>(this: Self): Self;
    ml_0p5<Self extends Element>(this: Self): Self;
    ml_1<Self extends Element>(this: Self): Self;
    ml_10<Self extends Element>(this: Self): Self;
    ml_11<Self extends Element>(this: Self): Self;
    ml_112<Self extends Element>(this: Self): Self;
    ml_12<Self extends Element>(this: Self): Self;
    ml_128<Self extends Element>(this: Self): Self;
    ml_16<Self extends Element>(this: Self): Self;
    ml_1_12<Self extends Element>(this: Self): Self;
    ml_1_2<Self extends Element>(this: Self): Self;
    ml_1_3<Self extends Element>(this: Self): Self;
    ml_1_4<Self extends Element>(this: Self): Self;
    ml_1_5<Self extends Element>(this: Self): Self;
    ml_1_6<Self extends Element>(this: Self): Self;
    ml_1p5<Self extends Element>(this: Self): Self;
    ml_2<Self extends Element>(this: Self): Self;
    ml_20<Self extends Element>(this: Self): Self;
    ml_24<Self extends Element>(this: Self): Self;
    ml_2_3<Self extends Element>(this: Self): Self;
    ml_2_4<Self extends Element>(this: Self): Self;
    ml_2_5<Self extends Element>(this: Self): Self;
    ml_2p5<Self extends Element>(this: Self): Self;
    ml_3<Self extends Element>(this: Self): Self;
    ml_32<Self extends Element>(this: Self): Self;
    ml_3_4<Self extends Element>(this: Self): Self;
    ml_3_5<Self extends Element>(this: Self): Self;
    ml_3p5<Self extends Element>(this: Self): Self;
    ml_4<Self extends Element>(this: Self): Self;
    ml_40<Self extends Element>(this: Self): Self;
    ml_48<Self extends Element>(this: Self): Self;
    ml_4_5<Self extends Element>(this: Self): Self;
    ml_5<Self extends Element>(this: Self): Self;
    ml_56<Self extends Element>(this: Self): Self;
    ml_5_6<Self extends Element>(this: Self): Self;
    ml_6<Self extends Element>(this: Self): Self;
    ml_64<Self extends Element>(this: Self): Self;
    ml_7<Self extends Element>(this: Self): Self;
    ml_72<Self extends Element>(this: Self): Self;
    ml_8<Self extends Element>(this: Self): Self;
    ml_80<Self extends Element>(this: Self): Self;
    ml_9<Self extends Element>(this: Self): Self;
    ml_96<Self extends Element>(this: Self): Self;
    ml_auto<Self extends Element>(this: Self): Self;
    ml_full<Self extends Element>(this: Self): Self;
    ml_neg_0<Self extends Element>(this: Self): Self;
    ml_neg_0p5<Self extends Element>(this: Self): Self;
    ml_neg_1<Self extends Element>(this: Self): Self;
    ml_neg_10<Self extends Element>(this: Self): Self;
    ml_neg_11<Self extends Element>(this: Self): Self;
    ml_neg_112<Self extends Element>(this: Self): Self;
    ml_neg_12<Self extends Element>(this: Self): Self;
    ml_neg_128<Self extends Element>(this: Self): Self;
    ml_neg_16<Self extends Element>(this: Self): Self;
    ml_neg_1_12<Self extends Element>(this: Self): Self;
    ml_neg_1_2<Self extends Element>(this: Self): Self;
    ml_neg_1_3<Self extends Element>(this: Self): Self;
    ml_neg_1_4<Self extends Element>(this: Self): Self;
    ml_neg_1_5<Self extends Element>(this: Self): Self;
    ml_neg_1_6<Self extends Element>(this: Self): Self;
    ml_neg_1p5<Self extends Element>(this: Self): Self;
    ml_neg_2<Self extends Element>(this: Self): Self;
    ml_neg_20<Self extends Element>(this: Self): Self;
    ml_neg_24<Self extends Element>(this: Self): Self;
    ml_neg_2_3<Self extends Element>(this: Self): Self;
    ml_neg_2_4<Self extends Element>(this: Self): Self;
    ml_neg_2_5<Self extends Element>(this: Self): Self;
    ml_neg_2p5<Self extends Element>(this: Self): Self;
    ml_neg_3<Self extends Element>(this: Self): Self;
    ml_neg_32<Self extends Element>(this: Self): Self;
    ml_neg_3_4<Self extends Element>(this: Self): Self;
    ml_neg_3_5<Self extends Element>(this: Self): Self;
    ml_neg_3p5<Self extends Element>(this: Self): Self;
    ml_neg_4<Self extends Element>(this: Self): Self;
    ml_neg_40<Self extends Element>(this: Self): Self;
    ml_neg_48<Self extends Element>(this: Self): Self;
    ml_neg_4_5<Self extends Element>(this: Self): Self;
    ml_neg_5<Self extends Element>(this: Self): Self;
    ml_neg_56<Self extends Element>(this: Self): Self;
    ml_neg_5_6<Self extends Element>(this: Self): Self;
    ml_neg_6<Self extends Element>(this: Self): Self;
    ml_neg_64<Self extends Element>(this: Self): Self;
    ml_neg_7<Self extends Element>(this: Self): Self;
    ml_neg_72<Self extends Element>(this: Self): Self;
    ml_neg_8<Self extends Element>(this: Self): Self;
    ml_neg_80<Self extends Element>(this: Self): Self;
    ml_neg_9<Self extends Element>(this: Self): Self;
    ml_neg_96<Self extends Element>(this: Self): Self;
    ml_neg_full<Self extends Element>(this: Self): Self;
    ml_neg_px<Self extends Element>(this: Self): Self;
    ml_px<Self extends Element>(this: Self): Self;
    mr_0<Self extends Element>(this: Self): Self;
    mr_0p5<Self extends Element>(this: Self): Self;
    mr_1<Self extends Element>(this: Self): Self;
    mr_10<Self extends Element>(this: Self): Self;
    mr_11<Self extends Element>(this: Self): Self;
    mr_112<Self extends Element>(this: Self): Self;
    mr_12<Self extends Element>(this: Self): Self;
    mr_128<Self extends Element>(this: Self): Self;
    mr_16<Self extends Element>(this: Self): Self;
    mr_1_12<Self extends Element>(this: Self): Self;
    mr_1_2<Self extends Element>(this: Self): Self;
    mr_1_3<Self extends Element>(this: Self): Self;
    mr_1_4<Self extends Element>(this: Self): Self;
    mr_1_5<Self extends Element>(this: Self): Self;
    mr_1_6<Self extends Element>(this: Self): Self;
    mr_1p5<Self extends Element>(this: Self): Self;
    mr_2<Self extends Element>(this: Self): Self;
    mr_20<Self extends Element>(this: Self): Self;
    mr_24<Self extends Element>(this: Self): Self;
    mr_2_3<Self extends Element>(this: Self): Self;
    mr_2_4<Self extends Element>(this: Self): Self;
    mr_2_5<Self extends Element>(this: Self): Self;
    mr_2p5<Self extends Element>(this: Self): Self;
    mr_3<Self extends Element>(this: Self): Self;
    mr_32<Self extends Element>(this: Self): Self;
    mr_3_4<Self extends Element>(this: Self): Self;
    mr_3_5<Self extends Element>(this: Self): Self;
    mr_3p5<Self extends Element>(this: Self): Self;
    mr_4<Self extends Element>(this: Self): Self;
    mr_40<Self extends Element>(this: Self): Self;
    mr_48<Self extends Element>(this: Self): Self;
    mr_4_5<Self extends Element>(this: Self): Self;
    mr_5<Self extends Element>(this: Self): Self;
    mr_56<Self extends Element>(this: Self): Self;
    mr_5_6<Self extends Element>(this: Self): Self;
    mr_6<Self extends Element>(this: Self): Self;
    mr_64<Self extends Element>(this: Self): Self;
    mr_7<Self extends Element>(this: Self): Self;
    mr_72<Self extends Element>(this: Self): Self;
    mr_8<Self extends Element>(this: Self): Self;
    mr_80<Self extends Element>(this: Self): Self;
    mr_9<Self extends Element>(this: Self): Self;
    mr_96<Self extends Element>(this: Self): Self;
    mr_auto<Self extends Element>(this: Self): Self;
    mr_full<Self extends Element>(this: Self): Self;
    mr_neg_0<Self extends Element>(this: Self): Self;
    mr_neg_0p5<Self extends Element>(this: Self): Self;
    mr_neg_1<Self extends Element>(this: Self): Self;
    mr_neg_10<Self extends Element>(this: Self): Self;
    mr_neg_11<Self extends Element>(this: Self): Self;
    mr_neg_112<Self extends Element>(this: Self): Self;
    mr_neg_12<Self extends Element>(this: Self): Self;
    mr_neg_128<Self extends Element>(this: Self): Self;
    mr_neg_16<Self extends Element>(this: Self): Self;
    mr_neg_1_12<Self extends Element>(this: Self): Self;
    mr_neg_1_2<Self extends Element>(this: Self): Self;
    mr_neg_1_3<Self extends Element>(this: Self): Self;
    mr_neg_1_4<Self extends Element>(this: Self): Self;
    mr_neg_1_5<Self extends Element>(this: Self): Self;
    mr_neg_1_6<Self extends Element>(this: Self): Self;
    mr_neg_1p5<Self extends Element>(this: Self): Self;
    mr_neg_2<Self extends Element>(this: Self): Self;
    mr_neg_20<Self extends Element>(this: Self): Self;
    mr_neg_24<Self extends Element>(this: Self): Self;
    mr_neg_2_3<Self extends Element>(this: Self): Self;
    mr_neg_2_4<Self extends Element>(this: Self): Self;
    mr_neg_2_5<Self extends Element>(this: Self): Self;
    mr_neg_2p5<Self extends Element>(this: Self): Self;
    mr_neg_3<Self extends Element>(this: Self): Self;
    mr_neg_32<Self extends Element>(this: Self): Self;
    mr_neg_3_4<Self extends Element>(this: Self): Self;
    mr_neg_3_5<Self extends Element>(this: Self): Self;
    mr_neg_3p5<Self extends Element>(this: Self): Self;
    mr_neg_4<Self extends Element>(this: Self): Self;
    mr_neg_40<Self extends Element>(this: Self): Self;
    mr_neg_48<Self extends Element>(this: Self): Self;
    mr_neg_4_5<Self extends Element>(this: Self): Self;
    mr_neg_5<Self extends Element>(this: Self): Self;
    mr_neg_56<Self extends Element>(this: Self): Self;
    mr_neg_5_6<Self extends Element>(this: Self): Self;
    mr_neg_6<Self extends Element>(this: Self): Self;
    mr_neg_64<Self extends Element>(this: Self): Self;
    mr_neg_7<Self extends Element>(this: Self): Self;
    mr_neg_72<Self extends Element>(this: Self): Self;
    mr_neg_8<Self extends Element>(this: Self): Self;
    mr_neg_80<Self extends Element>(this: Self): Self;
    mr_neg_9<Self extends Element>(this: Self): Self;
    mr_neg_96<Self extends Element>(this: Self): Self;
    mr_neg_full<Self extends Element>(this: Self): Self;
    mr_neg_px<Self extends Element>(this: Self): Self;
    mr_px<Self extends Element>(this: Self): Self;
    mt_0<Self extends Element>(this: Self): Self;
    mt_0p5<Self extends Element>(this: Self): Self;
    mt_1<Self extends Element>(this: Self): Self;
    mt_10<Self extends Element>(this: Self): Self;
    mt_11<Self extends Element>(this: Self): Self;
    mt_112<Self extends Element>(this: Self): Self;
    mt_12<Self extends Element>(this: Self): Self;
    mt_128<Self extends Element>(this: Self): Self;
    mt_16<Self extends Element>(this: Self): Self;
    mt_1_12<Self extends Element>(this: Self): Self;
    mt_1_2<Self extends Element>(this: Self): Self;
    mt_1_3<Self extends Element>(this: Self): Self;
    mt_1_4<Self extends Element>(this: Self): Self;
    mt_1_5<Self extends Element>(this: Self): Self;
    mt_1_6<Self extends Element>(this: Self): Self;
    mt_1p5<Self extends Element>(this: Self): Self;
    mt_2<Self extends Element>(this: Self): Self;
    mt_20<Self extends Element>(this: Self): Self;
    mt_24<Self extends Element>(this: Self): Self;
    mt_2_3<Self extends Element>(this: Self): Self;
    mt_2_4<Self extends Element>(this: Self): Self;
    mt_2_5<Self extends Element>(this: Self): Self;
    mt_2p5<Self extends Element>(this: Self): Self;
    mt_3<Self extends Element>(this: Self): Self;
    mt_32<Self extends Element>(this: Self): Self;
    mt_3_4<Self extends Element>(this: Self): Self;
    mt_3_5<Self extends Element>(this: Self): Self;
    mt_3p5<Self extends Element>(this: Self): Self;
    mt_4<Self extends Element>(this: Self): Self;
    mt_40<Self extends Element>(this: Self): Self;
    mt_48<Self extends Element>(this: Self): Self;
    mt_4_5<Self extends Element>(this: Self): Self;
    mt_5<Self extends Element>(this: Self): Self;
    mt_56<Self extends Element>(this: Self): Self;
    mt_5_6<Self extends Element>(this: Self): Self;
    mt_6<Self extends Element>(this: Self): Self;
    mt_64<Self extends Element>(this: Self): Self;
    mt_7<Self extends Element>(this: Self): Self;
    mt_72<Self extends Element>(this: Self): Self;
    mt_8<Self extends Element>(this: Self): Self;
    mt_80<Self extends Element>(this: Self): Self;
    mt_9<Self extends Element>(this: Self): Self;
    mt_96<Self extends Element>(this: Self): Self;
    mt_auto<Self extends Element>(this: Self): Self;
    mt_full<Self extends Element>(this: Self): Self;
    mt_neg_0<Self extends Element>(this: Self): Self;
    mt_neg_0p5<Self extends Element>(this: Self): Self;
    mt_neg_1<Self extends Element>(this: Self): Self;
    mt_neg_10<Self extends Element>(this: Self): Self;
    mt_neg_11<Self extends Element>(this: Self): Self;
    mt_neg_112<Self extends Element>(this: Self): Self;
    mt_neg_12<Self extends Element>(this: Self): Self;
    mt_neg_128<Self extends Element>(this: Self): Self;
    mt_neg_16<Self extends Element>(this: Self): Self;
    mt_neg_1_12<Self extends Element>(this: Self): Self;
    mt_neg_1_2<Self extends Element>(this: Self): Self;
    mt_neg_1_3<Self extends Element>(this: Self): Self;
    mt_neg_1_4<Self extends Element>(this: Self): Self;
    mt_neg_1_5<Self extends Element>(this: Self): Self;
    mt_neg_1_6<Self extends Element>(this: Self): Self;
    mt_neg_1p5<Self extends Element>(this: Self): Self;
    mt_neg_2<Self extends Element>(this: Self): Self;
    mt_neg_20<Self extends Element>(this: Self): Self;
    mt_neg_24<Self extends Element>(this: Self): Self;
    mt_neg_2_3<Self extends Element>(this: Self): Self;
    mt_neg_2_4<Self extends Element>(this: Self): Self;
    mt_neg_2_5<Self extends Element>(this: Self): Self;
    mt_neg_2p5<Self extends Element>(this: Self): Self;
    mt_neg_3<Self extends Element>(this: Self): Self;
    mt_neg_32<Self extends Element>(this: Self): Self;
    mt_neg_3_4<Self extends Element>(this: Self): Self;
    mt_neg_3_5<Self extends Element>(this: Self): Self;
    mt_neg_3p5<Self extends Element>(this: Self): Self;
    mt_neg_4<Self extends Element>(this: Self): Self;
    mt_neg_40<Self extends Element>(this: Self): Self;
    mt_neg_48<Self extends Element>(this: Self): Self;
    mt_neg_4_5<Self extends Element>(this: Self): Self;
    mt_neg_5<Self extends Element>(this: Self): Self;
    mt_neg_56<Self extends Element>(this: Self): Self;
    mt_neg_5_6<Self extends Element>(this: Self): Self;
    mt_neg_6<Self extends Element>(this: Self): Self;
    mt_neg_64<Self extends Element>(this: Self): Self;
    mt_neg_7<Self extends Element>(this: Self): Self;
    mt_neg_72<Self extends Element>(this: Self): Self;
    mt_neg_8<Self extends Element>(this: Self): Self;
    mt_neg_80<Self extends Element>(this: Self): Self;
    mt_neg_9<Self extends Element>(this: Self): Self;
    mt_neg_96<Self extends Element>(this: Self): Self;
    mt_neg_full<Self extends Element>(this: Self): Self;
    mt_neg_px<Self extends Element>(this: Self): Self;
    mt_px<Self extends Element>(this: Self): Self;
    mx_0<Self extends Element>(this: Self): Self;
    mx_0p5<Self extends Element>(this: Self): Self;
    mx_1<Self extends Element>(this: Self): Self;
    mx_10<Self extends Element>(this: Self): Self;
    mx_11<Self extends Element>(this: Self): Self;
    mx_112<Self extends Element>(this: Self): Self;
    mx_12<Self extends Element>(this: Self): Self;
    mx_128<Self extends Element>(this: Self): Self;
    mx_16<Self extends Element>(this: Self): Self;
    mx_1_12<Self extends Element>(this: Self): Self;
    mx_1_2<Self extends Element>(this: Self): Self;
    mx_1_3<Self extends Element>(this: Self): Self;
    mx_1_4<Self extends Element>(this: Self): Self;
    mx_1_5<Self extends Element>(this: Self): Self;
    mx_1_6<Self extends Element>(this: Self): Self;
    mx_1p5<Self extends Element>(this: Self): Self;
    mx_2<Self extends Element>(this: Self): Self;
    mx_20<Self extends Element>(this: Self): Self;
    mx_24<Self extends Element>(this: Self): Self;
    mx_2_3<Self extends Element>(this: Self): Self;
    mx_2_4<Self extends Element>(this: Self): Self;
    mx_2_5<Self extends Element>(this: Self): Self;
    mx_2p5<Self extends Element>(this: Self): Self;
    mx_3<Self extends Element>(this: Self): Self;
    mx_32<Self extends Element>(this: Self): Self;
    mx_3_4<Self extends Element>(this: Self): Self;
    mx_3_5<Self extends Element>(this: Self): Self;
    mx_3p5<Self extends Element>(this: Self): Self;
    mx_4<Self extends Element>(this: Self): Self;
    mx_40<Self extends Element>(this: Self): Self;
    mx_48<Self extends Element>(this: Self): Self;
    mx_4_5<Self extends Element>(this: Self): Self;
    mx_5<Self extends Element>(this: Self): Self;
    mx_56<Self extends Element>(this: Self): Self;
    mx_5_6<Self extends Element>(this: Self): Self;
    mx_6<Self extends Element>(this: Self): Self;
    mx_64<Self extends Element>(this: Self): Self;
    mx_7<Self extends Element>(this: Self): Self;
    mx_72<Self extends Element>(this: Self): Self;
    mx_8<Self extends Element>(this: Self): Self;
    mx_80<Self extends Element>(this: Self): Self;
    mx_9<Self extends Element>(this: Self): Self;
    mx_96<Self extends Element>(this: Self): Self;
    mx_auto<Self extends Element>(this: Self): Self;
    mx_full<Self extends Element>(this: Self): Self;
    mx_neg_0<Self extends Element>(this: Self): Self;
    mx_neg_0p5<Self extends Element>(this: Self): Self;
    mx_neg_1<Self extends Element>(this: Self): Self;
    mx_neg_10<Self extends Element>(this: Self): Self;
    mx_neg_11<Self extends Element>(this: Self): Self;
    mx_neg_112<Self extends Element>(this: Self): Self;
    mx_neg_12<Self extends Element>(this: Self): Self;
    mx_neg_128<Self extends Element>(this: Self): Self;
    mx_neg_16<Self extends Element>(this: Self): Self;
    mx_neg_1_12<Self extends Element>(this: Self): Self;
    mx_neg_1_2<Self extends Element>(this: Self): Self;
    mx_neg_1_3<Self extends Element>(this: Self): Self;
    mx_neg_1_4<Self extends Element>(this: Self): Self;
    mx_neg_1_5<Self extends Element>(this: Self): Self;
    mx_neg_1_6<Self extends Element>(this: Self): Self;
    mx_neg_1p5<Self extends Element>(this: Self): Self;
    mx_neg_2<Self extends Element>(this: Self): Self;
    mx_neg_20<Self extends Element>(this: Self): Self;
    mx_neg_24<Self extends Element>(this: Self): Self;
    mx_neg_2_3<Self extends Element>(this: Self): Self;
    mx_neg_2_4<Self extends Element>(this: Self): Self;
    mx_neg_2_5<Self extends Element>(this: Self): Self;
    mx_neg_2p5<Self extends Element>(this: Self): Self;
    mx_neg_3<Self extends Element>(this: Self): Self;
    mx_neg_32<Self extends Element>(this: Self): Self;
    mx_neg_3_4<Self extends Element>(this: Self): Self;
    mx_neg_3_5<Self extends Element>(this: Self): Self;
    mx_neg_3p5<Self extends Element>(this: Self): Self;
    mx_neg_4<Self extends Element>(this: Self): Self;
    mx_neg_40<Self extends Element>(this: Self): Self;
    mx_neg_48<Self extends Element>(this: Self): Self;
    mx_neg_4_5<Self extends Element>(this: Self): Self;
    mx_neg_5<Self extends Element>(this: Self): Self;
    mx_neg_56<Self extends Element>(this: Self): Self;
    mx_neg_5_6<Self extends Element>(this: Self): Self;
    mx_neg_6<Self extends Element>(this: Self): Self;
    mx_neg_64<Self extends Element>(this: Self): Self;
    mx_neg_7<Self extends Element>(this: Self): Self;
    mx_neg_72<Self extends Element>(this: Self): Self;
    mx_neg_8<Self extends Element>(this: Self): Self;
    mx_neg_80<Self extends Element>(this: Self): Self;
    mx_neg_9<Self extends Element>(this: Self): Self;
    mx_neg_96<Self extends Element>(this: Self): Self;
    mx_neg_full<Self extends Element>(this: Self): Self;
    mx_neg_px<Self extends Element>(this: Self): Self;
    mx_px<Self extends Element>(this: Self): Self;
    my_0<Self extends Element>(this: Self): Self;
    my_0p5<Self extends Element>(this: Self): Self;
    my_1<Self extends Element>(this: Self): Self;
    my_10<Self extends Element>(this: Self): Self;
    my_11<Self extends Element>(this: Self): Self;
    my_112<Self extends Element>(this: Self): Self;
    my_12<Self extends Element>(this: Self): Self;
    my_128<Self extends Element>(this: Self): Self;
    my_16<Self extends Element>(this: Self): Self;
    my_1_12<Self extends Element>(this: Self): Self;
    my_1_2<Self extends Element>(this: Self): Self;
    my_1_3<Self extends Element>(this: Self): Self;
    my_1_4<Self extends Element>(this: Self): Self;
    my_1_5<Self extends Element>(this: Self): Self;
    my_1_6<Self extends Element>(this: Self): Self;
    my_1p5<Self extends Element>(this: Self): Self;
    my_2<Self extends Element>(this: Self): Self;
    my_20<Self extends Element>(this: Self): Self;
    my_24<Self extends Element>(this: Self): Self;
    my_2_3<Self extends Element>(this: Self): Self;
    my_2_4<Self extends Element>(this: Self): Self;
    my_2_5<Self extends Element>(this: Self): Self;
    my_2p5<Self extends Element>(this: Self): Self;
    my_3<Self extends Element>(this: Self): Self;
    my_32<Self extends Element>(this: Self): Self;
    my_3_4<Self extends Element>(this: Self): Self;
    my_3_5<Self extends Element>(this: Self): Self;
    my_3p5<Self extends Element>(this: Self): Self;
    my_4<Self extends Element>(this: Self): Self;
    my_40<Self extends Element>(this: Self): Self;
    my_48<Self extends Element>(this: Self): Self;
    my_4_5<Self extends Element>(this: Self): Self;
    my_5<Self extends Element>(this: Self): Self;
    my_56<Self extends Element>(this: Self): Self;
    my_5_6<Self extends Element>(this: Self): Self;
    my_6<Self extends Element>(this: Self): Self;
    my_64<Self extends Element>(this: Self): Self;
    my_7<Self extends Element>(this: Self): Self;
    my_72<Self extends Element>(this: Self): Self;
    my_8<Self extends Element>(this: Self): Self;
    my_80<Self extends Element>(this: Self): Self;
    my_9<Self extends Element>(this: Self): Self;
    my_96<Self extends Element>(this: Self): Self;
    my_auto<Self extends Element>(this: Self): Self;
    my_full<Self extends Element>(this: Self): Self;
    my_neg_0<Self extends Element>(this: Self): Self;
    my_neg_0p5<Self extends Element>(this: Self): Self;
    my_neg_1<Self extends Element>(this: Self): Self;
    my_neg_10<Self extends Element>(this: Self): Self;
    my_neg_11<Self extends Element>(this: Self): Self;
    my_neg_112<Self extends Element>(this: Self): Self;
    my_neg_12<Self extends Element>(this: Self): Self;
    my_neg_128<Self extends Element>(this: Self): Self;
    my_neg_16<Self extends Element>(this: Self): Self;
    my_neg_1_12<Self extends Element>(this: Self): Self;
    my_neg_1_2<Self extends Element>(this: Self): Self;
    my_neg_1_3<Self extends Element>(this: Self): Self;
    my_neg_1_4<Self extends Element>(this: Self): Self;
    my_neg_1_5<Self extends Element>(this: Self): Self;
    my_neg_1_6<Self extends Element>(this: Self): Self;
    my_neg_1p5<Self extends Element>(this: Self): Self;
    my_neg_2<Self extends Element>(this: Self): Self;
    my_neg_20<Self extends Element>(this: Self): Self;
    my_neg_24<Self extends Element>(this: Self): Self;
    my_neg_2_3<Self extends Element>(this: Self): Self;
    my_neg_2_4<Self extends Element>(this: Self): Self;
    my_neg_2_5<Self extends Element>(this: Self): Self;
    my_neg_2p5<Self extends Element>(this: Self): Self;
    my_neg_3<Self extends Element>(this: Self): Self;
    my_neg_32<Self extends Element>(this: Self): Self;
    my_neg_3_4<Self extends Element>(this: Self): Self;
    my_neg_3_5<Self extends Element>(this: Self): Self;
    my_neg_3p5<Self extends Element>(this: Self): Self;
    my_neg_4<Self extends Element>(this: Self): Self;
    my_neg_40<Self extends Element>(this: Self): Self;
    my_neg_48<Self extends Element>(this: Self): Self;
    my_neg_4_5<Self extends Element>(this: Self): Self;
    my_neg_5<Self extends Element>(this: Self): Self;
    my_neg_56<Self extends Element>(this: Self): Self;
    my_neg_5_6<Self extends Element>(this: Self): Self;
    my_neg_6<Self extends Element>(this: Self): Self;
    my_neg_64<Self extends Element>(this: Self): Self;
    my_neg_7<Self extends Element>(this: Self): Self;
    my_neg_72<Self extends Element>(this: Self): Self;
    my_neg_8<Self extends Element>(this: Self): Self;
    my_neg_80<Self extends Element>(this: Self): Self;
    my_neg_9<Self extends Element>(this: Self): Self;
    my_neg_96<Self extends Element>(this: Self): Self;
    my_neg_full<Self extends Element>(this: Self): Self;
    my_neg_px<Self extends Element>(this: Self): Self;
    my_px<Self extends Element>(this: Self): Self;
    not_italic<Self extends Element>(this: Self): Self;
    overflow_hidden<Self extends Element>(this: Self): Self;
    overflow_x_hidden<Self extends Element>(this: Self): Self;
    overflow_y_hidden<Self extends Element>(this: Self): Self;
    p_0<Self extends Element>(this: Self): Self;
    p_0p5<Self extends Element>(this: Self): Self;
    p_1<Self extends Element>(this: Self): Self;
    p_10<Self extends Element>(this: Self): Self;
    p_11<Self extends Element>(this: Self): Self;
    p_112<Self extends Element>(this: Self): Self;
    p_12<Self extends Element>(this: Self): Self;
    p_128<Self extends Element>(this: Self): Self;
    p_16<Self extends Element>(this: Self): Self;
    p_1_12<Self extends Element>(this: Self): Self;
    p_1_2<Self extends Element>(this: Self): Self;
    p_1_3<Self extends Element>(this: Self): Self;
    p_1_4<Self extends Element>(this: Self): Self;
    p_1_5<Self extends Element>(this: Self): Self;
    p_1_6<Self extends Element>(this: Self): Self;
    p_1p5<Self extends Element>(this: Self): Self;
    p_2<Self extends Element>(this: Self): Self;
    p_20<Self extends Element>(this: Self): Self;
    p_24<Self extends Element>(this: Self): Self;
    p_2_3<Self extends Element>(this: Self): Self;
    p_2_4<Self extends Element>(this: Self): Self;
    p_2_5<Self extends Element>(this: Self): Self;
    p_2p5<Self extends Element>(this: Self): Self;
    p_3<Self extends Element>(this: Self): Self;
    p_32<Self extends Element>(this: Self): Self;
    p_3_4<Self extends Element>(this: Self): Self;
    p_3_5<Self extends Element>(this: Self): Self;
    p_3p5<Self extends Element>(this: Self): Self;
    p_4<Self extends Element>(this: Self): Self;
    p_40<Self extends Element>(this: Self): Self;
    p_48<Self extends Element>(this: Self): Self;
    p_4_5<Self extends Element>(this: Self): Self;
    p_5<Self extends Element>(this: Self): Self;
    p_56<Self extends Element>(this: Self): Self;
    p_5_6<Self extends Element>(this: Self): Self;
    p_6<Self extends Element>(this: Self): Self;
    p_64<Self extends Element>(this: Self): Self;
    p_7<Self extends Element>(this: Self): Self;
    p_72<Self extends Element>(this: Self): Self;
    p_8<Self extends Element>(this: Self): Self;
    p_80<Self extends Element>(this: Self): Self;
    p_9<Self extends Element>(this: Self): Self;
    p_96<Self extends Element>(this: Self): Self;
    p_full<Self extends Element>(this: Self): Self;
    p_neg_0<Self extends Element>(this: Self): Self;
    p_neg_0p5<Self extends Element>(this: Self): Self;
    p_neg_1<Self extends Element>(this: Self): Self;
    p_neg_10<Self extends Element>(this: Self): Self;
    p_neg_11<Self extends Element>(this: Self): Self;
    p_neg_112<Self extends Element>(this: Self): Self;
    p_neg_12<Self extends Element>(this: Self): Self;
    p_neg_128<Self extends Element>(this: Self): Self;
    p_neg_16<Self extends Element>(this: Self): Self;
    p_neg_1_12<Self extends Element>(this: Self): Self;
    p_neg_1_2<Self extends Element>(this: Self): Self;
    p_neg_1_3<Self extends Element>(this: Self): Self;
    p_neg_1_4<Self extends Element>(this: Self): Self;
    p_neg_1_5<Self extends Element>(this: Self): Self;
    p_neg_1_6<Self extends Element>(this: Self): Self;
    p_neg_1p5<Self extends Element>(this: Self): Self;
    p_neg_2<Self extends Element>(this: Self): Self;
    p_neg_20<Self extends Element>(this: Self): Self;
    p_neg_24<Self extends Element>(this: Self): Self;
    p_neg_2_3<Self extends Element>(this: Self): Self;
    p_neg_2_4<Self extends Element>(this: Self): Self;
    p_neg_2_5<Self extends Element>(this: Self): Self;
    p_neg_2p5<Self extends Element>(this: Self): Self;
    p_neg_3<Self extends Element>(this: Self): Self;
    p_neg_32<Self extends Element>(this: Self): Self;
    p_neg_3_4<Self extends Element>(this: Self): Self;
    p_neg_3_5<Self extends Element>(this: Self): Self;
    p_neg_3p5<Self extends Element>(this: Self): Self;
    p_neg_4<Self extends Element>(this: Self): Self;
    p_neg_40<Self extends Element>(this: Self): Self;
    p_neg_48<Self extends Element>(this: Self): Self;
    p_neg_4_5<Self extends Element>(this: Self): Self;
    p_neg_5<Self extends Element>(this: Self): Self;
    p_neg_56<Self extends Element>(this: Self): Self;
    p_neg_5_6<Self extends Element>(this: Self): Self;
    p_neg_6<Self extends Element>(this: Self): Self;
    p_neg_64<Self extends Element>(this: Self): Self;
    p_neg_7<Self extends Element>(this: Self): Self;
    p_neg_72<Self extends Element>(this: Self): Self;
    p_neg_8<Self extends Element>(this: Self): Self;
    p_neg_80<Self extends Element>(this: Self): Self;
    p_neg_9<Self extends Element>(this: Self): Self;
    p_neg_96<Self extends Element>(this: Self): Self;
    p_neg_full<Self extends Element>(this: Self): Self;
    p_neg_px<Self extends Element>(this: Self): Self;
    p_px<Self extends Element>(this: Self): Self;
    pb_0<Self extends Element>(this: Self): Self;
    pb_0p5<Self extends Element>(this: Self): Self;
    pb_1<Self extends Element>(this: Self): Self;
    pb_10<Self extends Element>(this: Self): Self;
    pb_11<Self extends Element>(this: Self): Self;
    pb_112<Self extends Element>(this: Self): Self;
    pb_12<Self extends Element>(this: Self): Self;
    pb_128<Self extends Element>(this: Self): Self;
    pb_16<Self extends Element>(this: Self): Self;
    pb_1_12<Self extends Element>(this: Self): Self;
    pb_1_2<Self extends Element>(this: Self): Self;
    pb_1_3<Self extends Element>(this: Self): Self;
    pb_1_4<Self extends Element>(this: Self): Self;
    pb_1_5<Self extends Element>(this: Self): Self;
    pb_1_6<Self extends Element>(this: Self): Self;
    pb_1p5<Self extends Element>(this: Self): Self;
    pb_2<Self extends Element>(this: Self): Self;
    pb_20<Self extends Element>(this: Self): Self;
    pb_24<Self extends Element>(this: Self): Self;
    pb_2_3<Self extends Element>(this: Self): Self;
    pb_2_4<Self extends Element>(this: Self): Self;
    pb_2_5<Self extends Element>(this: Self): Self;
    pb_2p5<Self extends Element>(this: Self): Self;
    pb_3<Self extends Element>(this: Self): Self;
    pb_32<Self extends Element>(this: Self): Self;
    pb_3_4<Self extends Element>(this: Self): Self;
    pb_3_5<Self extends Element>(this: Self): Self;
    pb_3p5<Self extends Element>(this: Self): Self;
    pb_4<Self extends Element>(this: Self): Self;
    pb_40<Self extends Element>(this: Self): Self;
    pb_48<Self extends Element>(this: Self): Self;
    pb_4_5<Self extends Element>(this: Self): Self;
    pb_5<Self extends Element>(this: Self): Self;
    pb_56<Self extends Element>(this: Self): Self;
    pb_5_6<Self extends Element>(this: Self): Self;
    pb_6<Self extends Element>(this: Self): Self;
    pb_64<Self extends Element>(this: Self): Self;
    pb_7<Self extends Element>(this: Self): Self;
    pb_72<Self extends Element>(this: Self): Self;
    pb_8<Self extends Element>(this: Self): Self;
    pb_80<Self extends Element>(this: Self): Self;
    pb_9<Self extends Element>(this: Self): Self;
    pb_96<Self extends Element>(this: Self): Self;
    pb_full<Self extends Element>(this: Self): Self;
    pb_neg_0<Self extends Element>(this: Self): Self;
    pb_neg_0p5<Self extends Element>(this: Self): Self;
    pb_neg_1<Self extends Element>(this: Self): Self;
    pb_neg_10<Self extends Element>(this: Self): Self;
    pb_neg_11<Self extends Element>(this: Self): Self;
    pb_neg_112<Self extends Element>(this: Self): Self;
    pb_neg_12<Self extends Element>(this: Self): Self;
    pb_neg_128<Self extends Element>(this: Self): Self;
    pb_neg_16<Self extends Element>(this: Self): Self;
    pb_neg_1_12<Self extends Element>(this: Self): Self;
    pb_neg_1_2<Self extends Element>(this: Self): Self;
    pb_neg_1_3<Self extends Element>(this: Self): Self;
    pb_neg_1_4<Self extends Element>(this: Self): Self;
    pb_neg_1_5<Self extends Element>(this: Self): Self;
    pb_neg_1_6<Self extends Element>(this: Self): Self;
    pb_neg_1p5<Self extends Element>(this: Self): Self;
    pb_neg_2<Self extends Element>(this: Self): Self;
    pb_neg_20<Self extends Element>(this: Self): Self;
    pb_neg_24<Self extends Element>(this: Self): Self;
    pb_neg_2_3<Self extends Element>(this: Self): Self;
    pb_neg_2_4<Self extends Element>(this: Self): Self;
    pb_neg_2_5<Self extends Element>(this: Self): Self;
    pb_neg_2p5<Self extends Element>(this: Self): Self;
    pb_neg_3<Self extends Element>(this: Self): Self;
    pb_neg_32<Self extends Element>(this: Self): Self;
    pb_neg_3_4<Self extends Element>(this: Self): Self;
    pb_neg_3_5<Self extends Element>(this: Self): Self;
    pb_neg_3p5<Self extends Element>(this: Self): Self;
    pb_neg_4<Self extends Element>(this: Self): Self;
    pb_neg_40<Self extends Element>(this: Self): Self;
    pb_neg_48<Self extends Element>(this: Self): Self;
    pb_neg_4_5<Self extends Element>(this: Self): Self;
    pb_neg_5<Self extends Element>(this: Self): Self;
    pb_neg_56<Self extends Element>(this: Self): Self;
    pb_neg_5_6<Self extends Element>(this: Self): Self;
    pb_neg_6<Self extends Element>(this: Self): Self;
    pb_neg_64<Self extends Element>(this: Self): Self;
    pb_neg_7<Self extends Element>(this: Self): Self;
    pb_neg_72<Self extends Element>(this: Self): Self;
    pb_neg_8<Self extends Element>(this: Self): Self;
    pb_neg_80<Self extends Element>(this: Self): Self;
    pb_neg_9<Self extends Element>(this: Self): Self;
    pb_neg_96<Self extends Element>(this: Self): Self;
    pb_neg_full<Self extends Element>(this: Self): Self;
    pb_neg_px<Self extends Element>(this: Self): Self;
    pb_px<Self extends Element>(this: Self): Self;
    pl_0<Self extends Element>(this: Self): Self;
    pl_0p5<Self extends Element>(this: Self): Self;
    pl_1<Self extends Element>(this: Self): Self;
    pl_10<Self extends Element>(this: Self): Self;
    pl_11<Self extends Element>(this: Self): Self;
    pl_112<Self extends Element>(this: Self): Self;
    pl_12<Self extends Element>(this: Self): Self;
    pl_128<Self extends Element>(this: Self): Self;
    pl_16<Self extends Element>(this: Self): Self;
    pl_1_12<Self extends Element>(this: Self): Self;
    pl_1_2<Self extends Element>(this: Self): Self;
    pl_1_3<Self extends Element>(this: Self): Self;
    pl_1_4<Self extends Element>(this: Self): Self;
    pl_1_5<Self extends Element>(this: Self): Self;
    pl_1_6<Self extends Element>(this: Self): Self;
    pl_1p5<Self extends Element>(this: Self): Self;
    pl_2<Self extends Element>(this: Self): Self;
    pl_20<Self extends Element>(this: Self): Self;
    pl_24<Self extends Element>(this: Self): Self;
    pl_2_3<Self extends Element>(this: Self): Self;
    pl_2_4<Self extends Element>(this: Self): Self;
    pl_2_5<Self extends Element>(this: Self): Self;
    pl_2p5<Self extends Element>(this: Self): Self;
    pl_3<Self extends Element>(this: Self): Self;
    pl_32<Self extends Element>(this: Self): Self;
    pl_3_4<Self extends Element>(this: Self): Self;
    pl_3_5<Self extends Element>(this: Self): Self;
    pl_3p5<Self extends Element>(this: Self): Self;
    pl_4<Self extends Element>(this: Self): Self;
    pl_40<Self extends Element>(this: Self): Self;
    pl_48<Self extends Element>(this: Self): Self;
    pl_4_5<Self extends Element>(this: Self): Self;
    pl_5<Self extends Element>(this: Self): Self;
    pl_56<Self extends Element>(this: Self): Self;
    pl_5_6<Self extends Element>(this: Self): Self;
    pl_6<Self extends Element>(this: Self): Self;
    pl_64<Self extends Element>(this: Self): Self;
    pl_7<Self extends Element>(this: Self): Self;
    pl_72<Self extends Element>(this: Self): Self;
    pl_8<Self extends Element>(this: Self): Self;
    pl_80<Self extends Element>(this: Self): Self;
    pl_9<Self extends Element>(this: Self): Self;
    pl_96<Self extends Element>(this: Self): Self;
    pl_full<Self extends Element>(this: Self): Self;
    pl_neg_0<Self extends Element>(this: Self): Self;
    pl_neg_0p5<Self extends Element>(this: Self): Self;
    pl_neg_1<Self extends Element>(this: Self): Self;
    pl_neg_10<Self extends Element>(this: Self): Self;
    pl_neg_11<Self extends Element>(this: Self): Self;
    pl_neg_112<Self extends Element>(this: Self): Self;
    pl_neg_12<Self extends Element>(this: Self): Self;
    pl_neg_128<Self extends Element>(this: Self): Self;
    pl_neg_16<Self extends Element>(this: Self): Self;
    pl_neg_1_12<Self extends Element>(this: Self): Self;
    pl_neg_1_2<Self extends Element>(this: Self): Self;
    pl_neg_1_3<Self extends Element>(this: Self): Self;
    pl_neg_1_4<Self extends Element>(this: Self): Self;
    pl_neg_1_5<Self extends Element>(this: Self): Self;
    pl_neg_1_6<Self extends Element>(this: Self): Self;
    pl_neg_1p5<Self extends Element>(this: Self): Self;
    pl_neg_2<Self extends Element>(this: Self): Self;
    pl_neg_20<Self extends Element>(this: Self): Self;
    pl_neg_24<Self extends Element>(this: Self): Self;
    pl_neg_2_3<Self extends Element>(this: Self): Self;
    pl_neg_2_4<Self extends Element>(this: Self): Self;
    pl_neg_2_5<Self extends Element>(this: Self): Self;
    pl_neg_2p5<Self extends Element>(this: Self): Self;
    pl_neg_3<Self extends Element>(this: Self): Self;
    pl_neg_32<Self extends Element>(this: Self): Self;
    pl_neg_3_4<Self extends Element>(this: Self): Self;
    pl_neg_3_5<Self extends Element>(this: Self): Self;
    pl_neg_3p5<Self extends Element>(this: Self): Self;
    pl_neg_4<Self extends Element>(this: Self): Self;
    pl_neg_40<Self extends Element>(this: Self): Self;
    pl_neg_48<Self extends Element>(this: Self): Self;
    pl_neg_4_5<Self extends Element>(this: Self): Self;
    pl_neg_5<Self extends Element>(this: Self): Self;
    pl_neg_56<Self extends Element>(this: Self): Self;
    pl_neg_5_6<Self extends Element>(this: Self): Self;
    pl_neg_6<Self extends Element>(this: Self): Self;
    pl_neg_64<Self extends Element>(this: Self): Self;
    pl_neg_7<Self extends Element>(this: Self): Self;
    pl_neg_72<Self extends Element>(this: Self): Self;
    pl_neg_8<Self extends Element>(this: Self): Self;
    pl_neg_80<Self extends Element>(this: Self): Self;
    pl_neg_9<Self extends Element>(this: Self): Self;
    pl_neg_96<Self extends Element>(this: Self): Self;
    pl_neg_full<Self extends Element>(this: Self): Self;
    pl_neg_px<Self extends Element>(this: Self): Self;
    pl_px<Self extends Element>(this: Self): Self;
    pr_0<Self extends Element>(this: Self): Self;
    pr_0p5<Self extends Element>(this: Self): Self;
    pr_1<Self extends Element>(this: Self): Self;
    pr_10<Self extends Element>(this: Self): Self;
    pr_11<Self extends Element>(this: Self): Self;
    pr_112<Self extends Element>(this: Self): Self;
    pr_12<Self extends Element>(this: Self): Self;
    pr_128<Self extends Element>(this: Self): Self;
    pr_16<Self extends Element>(this: Self): Self;
    pr_1_12<Self extends Element>(this: Self): Self;
    pr_1_2<Self extends Element>(this: Self): Self;
    pr_1_3<Self extends Element>(this: Self): Self;
    pr_1_4<Self extends Element>(this: Self): Self;
    pr_1_5<Self extends Element>(this: Self): Self;
    pr_1_6<Self extends Element>(this: Self): Self;
    pr_1p5<Self extends Element>(this: Self): Self;
    pr_2<Self extends Element>(this: Self): Self;
    pr_20<Self extends Element>(this: Self): Self;
    pr_24<Self extends Element>(this: Self): Self;
    pr_2_3<Self extends Element>(this: Self): Self;
    pr_2_4<Self extends Element>(this: Self): Self;
    pr_2_5<Self extends Element>(this: Self): Self;
    pr_2p5<Self extends Element>(this: Self): Self;
    pr_3<Self extends Element>(this: Self): Self;
    pr_32<Self extends Element>(this: Self): Self;
    pr_3_4<Self extends Element>(this: Self): Self;
    pr_3_5<Self extends Element>(this: Self): Self;
    pr_3p5<Self extends Element>(this: Self): Self;
    pr_4<Self extends Element>(this: Self): Self;
    pr_40<Self extends Element>(this: Self): Self;
    pr_48<Self extends Element>(this: Self): Self;
    pr_4_5<Self extends Element>(this: Self): Self;
    pr_5<Self extends Element>(this: Self): Self;
    pr_56<Self extends Element>(this: Self): Self;
    pr_5_6<Self extends Element>(this: Self): Self;
    pr_6<Self extends Element>(this: Self): Self;
    pr_64<Self extends Element>(this: Self): Self;
    pr_7<Self extends Element>(this: Self): Self;
    pr_72<Self extends Element>(this: Self): Self;
    pr_8<Self extends Element>(this: Self): Self;
    pr_80<Self extends Element>(this: Self): Self;
    pr_9<Self extends Element>(this: Self): Self;
    pr_96<Self extends Element>(this: Self): Self;
    pr_full<Self extends Element>(this: Self): Self;
    pr_neg_0<Self extends Element>(this: Self): Self;
    pr_neg_0p5<Self extends Element>(this: Self): Self;
    pr_neg_1<Self extends Element>(this: Self): Self;
    pr_neg_10<Self extends Element>(this: Self): Self;
    pr_neg_11<Self extends Element>(this: Self): Self;
    pr_neg_112<Self extends Element>(this: Self): Self;
    pr_neg_12<Self extends Element>(this: Self): Self;
    pr_neg_128<Self extends Element>(this: Self): Self;
    pr_neg_16<Self extends Element>(this: Self): Self;
    pr_neg_1_12<Self extends Element>(this: Self): Self;
    pr_neg_1_2<Self extends Element>(this: Self): Self;
    pr_neg_1_3<Self extends Element>(this: Self): Self;
    pr_neg_1_4<Self extends Element>(this: Self): Self;
    pr_neg_1_5<Self extends Element>(this: Self): Self;
    pr_neg_1_6<Self extends Element>(this: Self): Self;
    pr_neg_1p5<Self extends Element>(this: Self): Self;
    pr_neg_2<Self extends Element>(this: Self): Self;
    pr_neg_20<Self extends Element>(this: Self): Self;
    pr_neg_24<Self extends Element>(this: Self): Self;
    pr_neg_2_3<Self extends Element>(this: Self): Self;
    pr_neg_2_4<Self extends Element>(this: Self): Self;
    pr_neg_2_5<Self extends Element>(this: Self): Self;
    pr_neg_2p5<Self extends Element>(this: Self): Self;
    pr_neg_3<Self extends Element>(this: Self): Self;
    pr_neg_32<Self extends Element>(this: Self): Self;
    pr_neg_3_4<Self extends Element>(this: Self): Self;
    pr_neg_3_5<Self extends Element>(this: Self): Self;
    pr_neg_3p5<Self extends Element>(this: Self): Self;
    pr_neg_4<Self extends Element>(this: Self): Self;
    pr_neg_40<Self extends Element>(this: Self): Self;
    pr_neg_48<Self extends Element>(this: Self): Self;
    pr_neg_4_5<Self extends Element>(this: Self): Self;
    pr_neg_5<Self extends Element>(this: Self): Self;
    pr_neg_56<Self extends Element>(this: Self): Self;
    pr_neg_5_6<Self extends Element>(this: Self): Self;
    pr_neg_6<Self extends Element>(this: Self): Self;
    pr_neg_64<Self extends Element>(this: Self): Self;
    pr_neg_7<Self extends Element>(this: Self): Self;
    pr_neg_72<Self extends Element>(this: Self): Self;
    pr_neg_8<Self extends Element>(this: Self): Self;
    pr_neg_80<Self extends Element>(this: Self): Self;
    pr_neg_9<Self extends Element>(this: Self): Self;
    pr_neg_96<Self extends Element>(this: Self): Self;
    pr_neg_full<Self extends Element>(this: Self): Self;
    pr_neg_px<Self extends Element>(this: Self): Self;
    pr_px<Self extends Element>(this: Self): Self;
    pt_0<Self extends Element>(this: Self): Self;
    pt_0p5<Self extends Element>(this: Self): Self;
    pt_1<Self extends Element>(this: Self): Self;
    pt_10<Self extends Element>(this: Self): Self;
    pt_11<Self extends Element>(this: Self): Self;
    pt_112<Self extends Element>(this: Self): Self;
    pt_12<Self extends Element>(this: Self): Self;
    pt_128<Self extends Element>(this: Self): Self;
    pt_16<Self extends Element>(this: Self): Self;
    pt_1_12<Self extends Element>(this: Self): Self;
    pt_1_2<Self extends Element>(this: Self): Self;
    pt_1_3<Self extends Element>(this: Self): Self;
    pt_1_4<Self extends Element>(this: Self): Self;
    pt_1_5<Self extends Element>(this: Self): Self;
    pt_1_6<Self extends Element>(this: Self): Self;
    pt_1p5<Self extends Element>(this: Self): Self;
    pt_2<Self extends Element>(this: Self): Self;
    pt_20<Self extends Element>(this: Self): Self;
    pt_24<Self extends Element>(this: Self): Self;
    pt_2_3<Self extends Element>(this: Self): Self;
    pt_2_4<Self extends Element>(this: Self): Self;
    pt_2_5<Self extends Element>(this: Self): Self;
    pt_2p5<Self extends Element>(this: Self): Self;
    pt_3<Self extends Element>(this: Self): Self;
    pt_32<Self extends Element>(this: Self): Self;
    pt_3_4<Self extends Element>(this: Self): Self;
    pt_3_5<Self extends Element>(this: Self): Self;
    pt_3p5<Self extends Element>(this: Self): Self;
    pt_4<Self extends Element>(this: Self): Self;
    pt_40<Self extends Element>(this: Self): Self;
    pt_48<Self extends Element>(this: Self): Self;
    pt_4_5<Self extends Element>(this: Self): Self;
    pt_5<Self extends Element>(this: Self): Self;
    pt_56<Self extends Element>(this: Self): Self;
    pt_5_6<Self extends Element>(this: Self): Self;
    pt_6<Self extends Element>(this: Self): Self;
    pt_64<Self extends Element>(this: Self): Self;
    pt_7<Self extends Element>(this: Self): Self;
    pt_72<Self extends Element>(this: Self): Self;
    pt_8<Self extends Element>(this: Self): Self;
    pt_80<Self extends Element>(this: Self): Self;
    pt_9<Self extends Element>(this: Self): Self;
    pt_96<Self extends Element>(this: Self): Self;
    pt_full<Self extends Element>(this: Self): Self;
    pt_neg_0<Self extends Element>(this: Self): Self;
    pt_neg_0p5<Self extends Element>(this: Self): Self;
    pt_neg_1<Self extends Element>(this: Self): Self;
    pt_neg_10<Self extends Element>(this: Self): Self;
    pt_neg_11<Self extends Element>(this: Self): Self;
    pt_neg_112<Self extends Element>(this: Self): Self;
    pt_neg_12<Self extends Element>(this: Self): Self;
    pt_neg_128<Self extends Element>(this: Self): Self;
    pt_neg_16<Self extends Element>(this: Self): Self;
    pt_neg_1_12<Self extends Element>(this: Self): Self;
    pt_neg_1_2<Self extends Element>(this: Self): Self;
    pt_neg_1_3<Self extends Element>(this: Self): Self;
    pt_neg_1_4<Self extends Element>(this: Self): Self;
    pt_neg_1_5<Self extends Element>(this: Self): Self;
    pt_neg_1_6<Self extends Element>(this: Self): Self;
    pt_neg_1p5<Self extends Element>(this: Self): Self;
    pt_neg_2<Self extends Element>(this: Self): Self;
    pt_neg_20<Self extends Element>(this: Self): Self;
    pt_neg_24<Self extends Element>(this: Self): Self;
    pt_neg_2_3<Self extends Element>(this: Self): Self;
    pt_neg_2_4<Self extends Element>(this: Self): Self;
    pt_neg_2_5<Self extends Element>(this: Self): Self;
    pt_neg_2p5<Self extends Element>(this: Self): Self;
    pt_neg_3<Self extends Element>(this: Self): Self;
    pt_neg_32<Self extends Element>(this: Self): Self;
    pt_neg_3_4<Self extends Element>(this: Self): Self;
    pt_neg_3_5<Self extends Element>(this: Self): Self;
    pt_neg_3p5<Self extends Element>(this: Self): Self;
    pt_neg_4<Self extends Element>(this: Self): Self;
    pt_neg_40<Self extends Element>(this: Self): Self;
    pt_neg_48<Self extends Element>(this: Self): Self;
    pt_neg_4_5<Self extends Element>(this: Self): Self;
    pt_neg_5<Self extends Element>(this: Self): Self;
    pt_neg_56<Self extends Element>(this: Self): Self;
    pt_neg_5_6<Self extends Element>(this: Self): Self;
    pt_neg_6<Self extends Element>(this: Self): Self;
    pt_neg_64<Self extends Element>(this: Self): Self;
    pt_neg_7<Self extends Element>(this: Self): Self;
    pt_neg_72<Self extends Element>(this: Self): Self;
    pt_neg_8<Self extends Element>(this: Self): Self;
    pt_neg_80<Self extends Element>(this: Self): Self;
    pt_neg_9<Self extends Element>(this: Self): Self;
    pt_neg_96<Self extends Element>(this: Self): Self;
    pt_neg_full<Self extends Element>(this: Self): Self;
    pt_neg_px<Self extends Element>(this: Self): Self;
    pt_px<Self extends Element>(this: Self): Self;
    px_0<Self extends Element>(this: Self): Self;
    px_0p5<Self extends Element>(this: Self): Self;
    px_1<Self extends Element>(this: Self): Self;
    px_10<Self extends Element>(this: Self): Self;
    px_11<Self extends Element>(this: Self): Self;
    px_112<Self extends Element>(this: Self): Self;
    px_12<Self extends Element>(this: Self): Self;
    px_128<Self extends Element>(this: Self): Self;
    px_16<Self extends Element>(this: Self): Self;
    px_1_12<Self extends Element>(this: Self): Self;
    px_1_2<Self extends Element>(this: Self): Self;
    px_1_3<Self extends Element>(this: Self): Self;
    px_1_4<Self extends Element>(this: Self): Self;
    px_1_5<Self extends Element>(this: Self): Self;
    px_1_6<Self extends Element>(this: Self): Self;
    px_1p5<Self extends Element>(this: Self): Self;
    px_2<Self extends Element>(this: Self): Self;
    px_20<Self extends Element>(this: Self): Self;
    px_24<Self extends Element>(this: Self): Self;
    px_2_3<Self extends Element>(this: Self): Self;
    px_2_4<Self extends Element>(this: Self): Self;
    px_2_5<Self extends Element>(this: Self): Self;
    px_2p5<Self extends Element>(this: Self): Self;
    px_3<Self extends Element>(this: Self): Self;
    px_32<Self extends Element>(this: Self): Self;
    px_3_4<Self extends Element>(this: Self): Self;
    px_3_5<Self extends Element>(this: Self): Self;
    px_3p5<Self extends Element>(this: Self): Self;
    px_4<Self extends Element>(this: Self): Self;
    px_40<Self extends Element>(this: Self): Self;
    px_48<Self extends Element>(this: Self): Self;
    px_4_5<Self extends Element>(this: Self): Self;
    px_5<Self extends Element>(this: Self): Self;
    px_56<Self extends Element>(this: Self): Self;
    px_5_6<Self extends Element>(this: Self): Self;
    px_6<Self extends Element>(this: Self): Self;
    px_64<Self extends Element>(this: Self): Self;
    px_7<Self extends Element>(this: Self): Self;
    px_72<Self extends Element>(this: Self): Self;
    px_8<Self extends Element>(this: Self): Self;
    px_80<Self extends Element>(this: Self): Self;
    px_9<Self extends Element>(this: Self): Self;
    px_96<Self extends Element>(this: Self): Self;
    px_full<Self extends Element>(this: Self): Self;
    px_neg_0<Self extends Element>(this: Self): Self;
    px_neg_0p5<Self extends Element>(this: Self): Self;
    px_neg_1<Self extends Element>(this: Self): Self;
    px_neg_10<Self extends Element>(this: Self): Self;
    px_neg_11<Self extends Element>(this: Self): Self;
    px_neg_112<Self extends Element>(this: Self): Self;
    px_neg_12<Self extends Element>(this: Self): Self;
    px_neg_128<Self extends Element>(this: Self): Self;
    px_neg_16<Self extends Element>(this: Self): Self;
    px_neg_1_12<Self extends Element>(this: Self): Self;
    px_neg_1_2<Self extends Element>(this: Self): Self;
    px_neg_1_3<Self extends Element>(this: Self): Self;
    px_neg_1_4<Self extends Element>(this: Self): Self;
    px_neg_1_5<Self extends Element>(this: Self): Self;
    px_neg_1_6<Self extends Element>(this: Self): Self;
    px_neg_1p5<Self extends Element>(this: Self): Self;
    px_neg_2<Self extends Element>(this: Self): Self;
    px_neg_20<Self extends Element>(this: Self): Self;
    px_neg_24<Self extends Element>(this: Self): Self;
    px_neg_2_3<Self extends Element>(this: Self): Self;
    px_neg_2_4<Self extends Element>(this: Self): Self;
    px_neg_2_5<Self extends Element>(this: Self): Self;
    px_neg_2p5<Self extends Element>(this: Self): Self;
    px_neg_3<Self extends Element>(this: Self): Self;
    px_neg_32<Self extends Element>(this: Self): Self;
    px_neg_3_4<Self extends Element>(this: Self): Self;
    px_neg_3_5<Self extends Element>(this: Self): Self;
    px_neg_3p5<Self extends Element>(this: Self): Self;
    px_neg_4<Self extends Element>(this: Self): Self;
    px_neg_40<Self extends Element>(this: Self): Self;
    px_neg_48<Self extends Element>(this: Self): Self;
    px_neg_4_5<Self extends Element>(this: Self): Self;
    px_neg_5<Self extends Element>(this: Self): Self;
    px_neg_56<Self extends Element>(this: Self): Self;
    px_neg_5_6<Self extends Element>(this: Self): Self;
    px_neg_6<Self extends Element>(this: Self): Self;
    px_neg_64<Self extends Element>(this: Self): Self;
    px_neg_7<Self extends Element>(this: Self): Self;
    px_neg_72<Self extends Element>(this: Self): Self;
    px_neg_8<Self extends Element>(this: Self): Self;
    px_neg_80<Self extends Element>(this: Self): Self;
    px_neg_9<Self extends Element>(this: Self): Self;
    px_neg_96<Self extends Element>(this: Self): Self;
    px_neg_full<Self extends Element>(this: Self): Self;
    px_neg_px<Self extends Element>(this: Self): Self;
    px_px<Self extends Element>(this: Self): Self;
    py_0<Self extends Element>(this: Self): Self;
    py_0p5<Self extends Element>(this: Self): Self;
    py_1<Self extends Element>(this: Self): Self;
    py_10<Self extends Element>(this: Self): Self;
    py_11<Self extends Element>(this: Self): Self;
    py_112<Self extends Element>(this: Self): Self;
    py_12<Self extends Element>(this: Self): Self;
    py_128<Self extends Element>(this: Self): Self;
    py_16<Self extends Element>(this: Self): Self;
    py_1_12<Self extends Element>(this: Self): Self;
    py_1_2<Self extends Element>(this: Self): Self;
    py_1_3<Self extends Element>(this: Self): Self;
    py_1_4<Self extends Element>(this: Self): Self;
    py_1_5<Self extends Element>(this: Self): Self;
    py_1_6<Self extends Element>(this: Self): Self;
    py_1p5<Self extends Element>(this: Self): Self;
    py_2<Self extends Element>(this: Self): Self;
    py_20<Self extends Element>(this: Self): Self;
    py_24<Self extends Element>(this: Self): Self;
    py_2_3<Self extends Element>(this: Self): Self;
    py_2_4<Self extends Element>(this: Self): Self;
    py_2_5<Self extends Element>(this: Self): Self;
    py_2p5<Self extends Element>(this: Self): Self;
    py_3<Self extends Element>(this: Self): Self;
    py_32<Self extends Element>(this: Self): Self;
    py_3_4<Self extends Element>(this: Self): Self;
    py_3_5<Self extends Element>(this: Self): Self;
    py_3p5<Self extends Element>(this: Self): Self;
    py_4<Self extends Element>(this: Self): Self;
    py_40<Self extends Element>(this: Self): Self;
    py_48<Self extends Element>(this: Self): Self;
    py_4_5<Self extends Element>(this: Self): Self;
    py_5<Self extends Element>(this: Self): Self;
    py_56<Self extends Element>(this: Self): Self;
    py_5_6<Self extends Element>(this: Self): Self;
    py_6<Self extends Element>(this: Self): Self;
    py_64<Self extends Element>(this: Self): Self;
    py_7<Self extends Element>(this: Self): Self;
    py_72<Self extends Element>(this: Self): Self;
    py_8<Self extends Element>(this: Self): Self;
    py_80<Self extends Element>(this: Self): Self;
    py_9<Self extends Element>(this: Self): Self;
    py_96<Self extends Element>(this: Self): Self;
    py_full<Self extends Element>(this: Self): Self;
    py_neg_0<Self extends Element>(this: Self): Self;
    py_neg_0p5<Self extends Element>(this: Self): Self;
    py_neg_1<Self extends Element>(this: Self): Self;
    py_neg_10<Self extends Element>(this: Self): Self;
    py_neg_11<Self extends Element>(this: Self): Self;
    py_neg_112<Self extends Element>(this: Self): Self;
    py_neg_12<Self extends Element>(this: Self): Self;
    py_neg_128<Self extends Element>(this: Self): Self;
    py_neg_16<Self extends Element>(this: Self): Self;
    py_neg_1_12<Self extends Element>(this: Self): Self;
    py_neg_1_2<Self extends Element>(this: Self): Self;
    py_neg_1_3<Self extends Element>(this: Self): Self;
    py_neg_1_4<Self extends Element>(this: Self): Self;
    py_neg_1_5<Self extends Element>(this: Self): Self;
    py_neg_1_6<Self extends Element>(this: Self): Self;
    py_neg_1p5<Self extends Element>(this: Self): Self;
    py_neg_2<Self extends Element>(this: Self): Self;
    py_neg_20<Self extends Element>(this: Self): Self;
    py_neg_24<Self extends Element>(this: Self): Self;
    py_neg_2_3<Self extends Element>(this: Self): Self;
    py_neg_2_4<Self extends Element>(this: Self): Self;
    py_neg_2_5<Self extends Element>(this: Self): Self;
    py_neg_2p5<Self extends Element>(this: Self): Self;
    py_neg_3<Self extends Element>(this: Self): Self;
    py_neg_32<Self extends Element>(this: Self): Self;
    py_neg_3_4<Self extends Element>(this: Self): Self;
    py_neg_3_5<Self extends Element>(this: Self): Self;
    py_neg_3p5<Self extends Element>(this: Self): Self;
    py_neg_4<Self extends Element>(this: Self): Self;
    py_neg_40<Self extends Element>(this: Self): Self;
    py_neg_48<Self extends Element>(this: Self): Self;
    py_neg_4_5<Self extends Element>(this: Self): Self;
    py_neg_5<Self extends Element>(this: Self): Self;
    py_neg_56<Self extends Element>(this: Self): Self;
    py_neg_5_6<Self extends Element>(this: Self): Self;
    py_neg_6<Self extends Element>(this: Self): Self;
    py_neg_64<Self extends Element>(this: Self): Self;
    py_neg_7<Self extends Element>(this: Self): Self;
    py_neg_72<Self extends Element>(this: Self): Self;
    py_neg_8<Self extends Element>(this: Self): Self;
    py_neg_80<Self extends Element>(this: Self): Self;
    py_neg_9<Self extends Element>(this: Self): Self;
    py_neg_96<Self extends Element>(this: Self): Self;
    py_neg_full<Self extends Element>(this: Self): Self;
    py_neg_px<Self extends Element>(this: Self): Self;
    py_px<Self extends Element>(this: Self): Self;
    relative<Self extends Element>(this: Self): Self;
    right_0<Self extends Element>(this: Self): Self;
    right_0p5<Self extends Element>(this: Self): Self;
    right_1<Self extends Element>(this: Self): Self;
    right_10<Self extends Element>(this: Self): Self;
    right_11<Self extends Element>(this: Self): Self;
    right_112<Self extends Element>(this: Self): Self;
    right_12<Self extends Element>(this: Self): Self;
    right_128<Self extends Element>(this: Self): Self;
    right_16<Self extends Element>(this: Self): Self;
    right_1_12<Self extends Element>(this: Self): Self;
    right_1_2<Self extends Element>(this: Self): Self;
    right_1_3<Self extends Element>(this: Self): Self;
    right_1_4<Self extends Element>(this: Self): Self;
    right_1_5<Self extends Element>(this: Self): Self;
    right_1_6<Self extends Element>(this: Self): Self;
    right_1p5<Self extends Element>(this: Self): Self;
    right_2<Self extends Element>(this: Self): Self;
    right_20<Self extends Element>(this: Self): Self;
    right_24<Self extends Element>(this: Self): Self;
    right_2_3<Self extends Element>(this: Self): Self;
    right_2_4<Self extends Element>(this: Self): Self;
    right_2_5<Self extends Element>(this: Self): Self;
    right_2p5<Self extends Element>(this: Self): Self;
    right_3<Self extends Element>(this: Self): Self;
    right_32<Self extends Element>(this: Self): Self;
    right_3_4<Self extends Element>(this: Self): Self;
    right_3_5<Self extends Element>(this: Self): Self;
    right_3p5<Self extends Element>(this: Self): Self;
    right_4<Self extends Element>(this: Self): Self;
    right_40<Self extends Element>(this: Self): Self;
    right_48<Self extends Element>(this: Self): Self;
    right_4_5<Self extends Element>(this: Self): Self;
    right_5<Self extends Element>(this: Self): Self;
    right_56<Self extends Element>(this: Self): Self;
    right_5_6<Self extends Element>(this: Self): Self;
    right_6<Self extends Element>(this: Self): Self;
    right_64<Self extends Element>(this: Self): Self;
    right_7<Self extends Element>(this: Self): Self;
    right_72<Self extends Element>(this: Self): Self;
    right_8<Self extends Element>(this: Self): Self;
    right_80<Self extends Element>(this: Self): Self;
    right_9<Self extends Element>(this: Self): Self;
    right_96<Self extends Element>(this: Self): Self;
    right_auto<Self extends Element>(this: Self): Self;
    right_full<Self extends Element>(this: Self): Self;
    right_neg_0<Self extends Element>(this: Self): Self;
    right_neg_0p5<Self extends Element>(this: Self): Self;
    right_neg_1<Self extends Element>(this: Self): Self;
    right_neg_10<Self extends Element>(this: Self): Self;
    right_neg_11<Self extends Element>(this: Self): Self;
    right_neg_112<Self extends Element>(this: Self): Self;
    right_neg_12<Self extends Element>(this: Self): Self;
    right_neg_128<Self extends Element>(this: Self): Self;
    right_neg_16<Self extends Element>(this: Self): Self;
    right_neg_1_12<Self extends Element>(this: Self): Self;
    right_neg_1_2<Self extends Element>(this: Self): Self;
    right_neg_1_3<Self extends Element>(this: Self): Self;
    right_neg_1_4<Self extends Element>(this: Self): Self;
    right_neg_1_5<Self extends Element>(this: Self): Self;
    right_neg_1_6<Self extends Element>(this: Self): Self;
    right_neg_1p5<Self extends Element>(this: Self): Self;
    right_neg_2<Self extends Element>(this: Self): Self;
    right_neg_20<Self extends Element>(this: Self): Self;
    right_neg_24<Self extends Element>(this: Self): Self;
    right_neg_2_3<Self extends Element>(this: Self): Self;
    right_neg_2_4<Self extends Element>(this: Self): Self;
    right_neg_2_5<Self extends Element>(this: Self): Self;
    right_neg_2p5<Self extends Element>(this: Self): Self;
    right_neg_3<Self extends Element>(this: Self): Self;
    right_neg_32<Self extends Element>(this: Self): Self;
    right_neg_3_4<Self extends Element>(this: Self): Self;
    right_neg_3_5<Self extends Element>(this: Self): Self;
    right_neg_3p5<Self extends Element>(this: Self): Self;
    right_neg_4<Self extends Element>(this: Self): Self;
    right_neg_40<Self extends Element>(this: Self): Self;
    right_neg_48<Self extends Element>(this: Self): Self;
    right_neg_4_5<Self extends Element>(this: Self): Self;
    right_neg_5<Self extends Element>(this: Self): Self;
    right_neg_56<Self extends Element>(this: Self): Self;
    right_neg_5_6<Self extends Element>(this: Self): Self;
    right_neg_6<Self extends Element>(this: Self): Self;
    right_neg_64<Self extends Element>(this: Self): Self;
    right_neg_7<Self extends Element>(this: Self): Self;
    right_neg_72<Self extends Element>(this: Self): Self;
    right_neg_8<Self extends Element>(this: Self): Self;
    right_neg_80<Self extends Element>(this: Self): Self;
    right_neg_9<Self extends Element>(this: Self): Self;
    right_neg_96<Self extends Element>(this: Self): Self;
    right_neg_full<Self extends Element>(this: Self): Self;
    right_neg_px<Self extends Element>(this: Self): Self;
    right_px<Self extends Element>(this: Self): Self;
    rounded_2xl<Self extends Element>(this: Self): Self;
    rounded_3xl<Self extends Element>(this: Self): Self;
    rounded_b_2xl<Self extends Element>(this: Self): Self;
    rounded_b_3xl<Self extends Element>(this: Self): Self;
    rounded_b_full<Self extends Element>(this: Self): Self;
    rounded_b_lg<Self extends Element>(this: Self): Self;
    rounded_b_md<Self extends Element>(this: Self): Self;
    rounded_b_none<Self extends Element>(this: Self): Self;
    rounded_b_sm<Self extends Element>(this: Self): Self;
    rounded_b_xl<Self extends Element>(this: Self): Self;
    rounded_b_xs<Self extends Element>(this: Self): Self;
    rounded_bl_2xl<Self extends Element>(this: Self): Self;
    rounded_bl_3xl<Self extends Element>(this: Self): Self;
    rounded_bl_full<Self extends Element>(this: Self): Self;
    rounded_bl_lg<Self extends Element>(this: Self): Self;
    rounded_bl_md<Self extends Element>(this: Self): Self;
    rounded_bl_none<Self extends Element>(this: Self): Self;
    rounded_bl_sm<Self extends Element>(this: Self): Self;
    rounded_bl_xl<Self extends Element>(this: Self): Self;
    rounded_bl_xs<Self extends Element>(this: Self): Self;
    rounded_br_2xl<Self extends Element>(this: Self): Self;
    rounded_br_3xl<Self extends Element>(this: Self): Self;
    rounded_br_full<Self extends Element>(this: Self): Self;
    rounded_br_lg<Self extends Element>(this: Self): Self;
    rounded_br_md<Self extends Element>(this: Self): Self;
    rounded_br_none<Self extends Element>(this: Self): Self;
    rounded_br_sm<Self extends Element>(this: Self): Self;
    rounded_br_xl<Self extends Element>(this: Self): Self;
    rounded_br_xs<Self extends Element>(this: Self): Self;
    rounded_full<Self extends Element>(this: Self): Self;
    rounded_l_2xl<Self extends Element>(this: Self): Self;
    rounded_l_3xl<Self extends Element>(this: Self): Self;
    rounded_l_full<Self extends Element>(this: Self): Self;
    rounded_l_lg<Self extends Element>(this: Self): Self;
    rounded_l_md<Self extends Element>(this: Self): Self;
    rounded_l_none<Self extends Element>(this: Self): Self;
    rounded_l_sm<Self extends Element>(this: Self): Self;
    rounded_l_xl<Self extends Element>(this: Self): Self;
    rounded_l_xs<Self extends Element>(this: Self): Self;
    rounded_lg<Self extends Element>(this: Self): Self;
    rounded_md<Self extends Element>(this: Self): Self;
    rounded_none<Self extends Element>(this: Self): Self;
    rounded_r_2xl<Self extends Element>(this: Self): Self;
    rounded_r_3xl<Self extends Element>(this: Self): Self;
    rounded_r_full<Self extends Element>(this: Self): Self;
    rounded_r_lg<Self extends Element>(this: Self): Self;
    rounded_r_md<Self extends Element>(this: Self): Self;
    rounded_r_none<Self extends Element>(this: Self): Self;
    rounded_r_sm<Self extends Element>(this: Self): Self;
    rounded_r_xl<Self extends Element>(this: Self): Self;
    rounded_r_xs<Self extends Element>(this: Self): Self;
    rounded_sm<Self extends Element>(this: Self): Self;
    rounded_t_2xl<Self extends Element>(this: Self): Self;
    rounded_t_3xl<Self extends Element>(this: Self): Self;
    rounded_t_full<Self extends Element>(this: Self): Self;
    rounded_t_lg<Self extends Element>(this: Self): Self;
    rounded_t_md<Self extends Element>(this: Self): Self;
    rounded_t_none<Self extends Element>(this: Self): Self;
    rounded_t_sm<Self extends Element>(this: Self): Self;
    rounded_t_xl<Self extends Element>(this: Self): Self;
    rounded_t_xs<Self extends Element>(this: Self): Self;
    rounded_tl_2xl<Self extends Element>(this: Self): Self;
    rounded_tl_3xl<Self extends Element>(this: Self): Self;
    rounded_tl_full<Self extends Element>(this: Self): Self;
    rounded_tl_lg<Self extends Element>(this: Self): Self;
    rounded_tl_md<Self extends Element>(this: Self): Self;
    rounded_tl_none<Self extends Element>(this: Self): Self;
    rounded_tl_sm<Self extends Element>(this: Self): Self;
    rounded_tl_xl<Self extends Element>(this: Self): Self;
    rounded_tl_xs<Self extends Element>(this: Self): Self;
    rounded_tr_2xl<Self extends Element>(this: Self): Self;
    rounded_tr_3xl<Self extends Element>(this: Self): Self;
    rounded_tr_full<Self extends Element>(this: Self): Self;
    rounded_tr_lg<Self extends Element>(this: Self): Self;
    rounded_tr_md<Self extends Element>(this: Self): Self;
    rounded_tr_none<Self extends Element>(this: Self): Self;
    rounded_tr_sm<Self extends Element>(this: Self): Self;
    rounded_tr_xl<Self extends Element>(this: Self): Self;
    rounded_tr_xs<Self extends Element>(this: Self): Self;
    rounded_xl<Self extends Element>(this: Self): Self;
    rounded_xs<Self extends Element>(this: Self): Self;
    row_end_auto<Self extends Element>(this: Self): Self;
    row_span_full<Self extends Element>(this: Self): Self;
    row_start_auto<Self extends Element>(this: Self): Self;
    self_baseline<Self extends Element>(this: Self): Self;
    self_center<Self extends Element>(this: Self): Self;
    self_end<Self extends Element>(this: Self): Self;
    self_flex_end<Self extends Element>(this: Self): Self;
    self_flex_start<Self extends Element>(this: Self): Self;
    self_start<Self extends Element>(this: Self): Self;
    self_stretch<Self extends Element>(this: Self): Self;
    shadow_2xl<Self extends Element>(this: Self): Self;
    shadow_2xs<Self extends Element>(this: Self): Self;
    shadow_lg<Self extends Element>(this: Self): Self;
    shadow_md<Self extends Element>(this: Self): Self;
    shadow_none<Self extends Element>(this: Self): Self;
    shadow_sm<Self extends Element>(this: Self): Self;
    shadow_xl<Self extends Element>(this: Self): Self;
    shadow_xs<Self extends Element>(this: Self): Self;
    size_0<Self extends Element>(this: Self): Self;
    size_0p5<Self extends Element>(this: Self): Self;
    size_1<Self extends Element>(this: Self): Self;
    size_10<Self extends Element>(this: Self): Self;
    size_11<Self extends Element>(this: Self): Self;
    size_112<Self extends Element>(this: Self): Self;
    size_12<Self extends Element>(this: Self): Self;
    size_128<Self extends Element>(this: Self): Self;
    size_16<Self extends Element>(this: Self): Self;
    size_1_12<Self extends Element>(this: Self): Self;
    size_1_2<Self extends Element>(this: Self): Self;
    size_1_3<Self extends Element>(this: Self): Self;
    size_1_4<Self extends Element>(this: Self): Self;
    size_1_5<Self extends Element>(this: Self): Self;
    size_1_6<Self extends Element>(this: Self): Self;
    size_1p5<Self extends Element>(this: Self): Self;
    size_2<Self extends Element>(this: Self): Self;
    size_20<Self extends Element>(this: Self): Self;
    size_24<Self extends Element>(this: Self): Self;
    size_2_3<Self extends Element>(this: Self): Self;
    size_2_4<Self extends Element>(this: Self): Self;
    size_2_5<Self extends Element>(this: Self): Self;
    size_2p5<Self extends Element>(this: Self): Self;
    size_3<Self extends Element>(this: Self): Self;
    size_32<Self extends Element>(this: Self): Self;
    size_3_4<Self extends Element>(this: Self): Self;
    size_3_5<Self extends Element>(this: Self): Self;
    size_3p5<Self extends Element>(this: Self): Self;
    size_4<Self extends Element>(this: Self): Self;
    size_40<Self extends Element>(this: Self): Self;
    size_48<Self extends Element>(this: Self): Self;
    size_4_5<Self extends Element>(this: Self): Self;
    size_5<Self extends Element>(this: Self): Self;
    size_56<Self extends Element>(this: Self): Self;
    size_5_6<Self extends Element>(this: Self): Self;
    size_6<Self extends Element>(this: Self): Self;
    size_64<Self extends Element>(this: Self): Self;
    size_7<Self extends Element>(this: Self): Self;
    size_72<Self extends Element>(this: Self): Self;
    size_8<Self extends Element>(this: Self): Self;
    size_80<Self extends Element>(this: Self): Self;
    size_9<Self extends Element>(this: Self): Self;
    size_96<Self extends Element>(this: Self): Self;
    size_auto<Self extends Element>(this: Self): Self;
    size_full<Self extends Element>(this: Self): Self;
    size_neg_0<Self extends Element>(this: Self): Self;
    size_neg_0p5<Self extends Element>(this: Self): Self;
    size_neg_1<Self extends Element>(this: Self): Self;
    size_neg_10<Self extends Element>(this: Self): Self;
    size_neg_11<Self extends Element>(this: Self): Self;
    size_neg_112<Self extends Element>(this: Self): Self;
    size_neg_12<Self extends Element>(this: Self): Self;
    size_neg_128<Self extends Element>(this: Self): Self;
    size_neg_16<Self extends Element>(this: Self): Self;
    size_neg_1_12<Self extends Element>(this: Self): Self;
    size_neg_1_2<Self extends Element>(this: Self): Self;
    size_neg_1_3<Self extends Element>(this: Self): Self;
    size_neg_1_4<Self extends Element>(this: Self): Self;
    size_neg_1_5<Self extends Element>(this: Self): Self;
    size_neg_1_6<Self extends Element>(this: Self): Self;
    size_neg_1p5<Self extends Element>(this: Self): Self;
    size_neg_2<Self extends Element>(this: Self): Self;
    size_neg_20<Self extends Element>(this: Self): Self;
    size_neg_24<Self extends Element>(this: Self): Self;
    size_neg_2_3<Self extends Element>(this: Self): Self;
    size_neg_2_4<Self extends Element>(this: Self): Self;
    size_neg_2_5<Self extends Element>(this: Self): Self;
    size_neg_2p5<Self extends Element>(this: Self): Self;
    size_neg_3<Self extends Element>(this: Self): Self;
    size_neg_32<Self extends Element>(this: Self): Self;
    size_neg_3_4<Self extends Element>(this: Self): Self;
    size_neg_3_5<Self extends Element>(this: Self): Self;
    size_neg_3p5<Self extends Element>(this: Self): Self;
    size_neg_4<Self extends Element>(this: Self): Self;
    size_neg_40<Self extends Element>(this: Self): Self;
    size_neg_48<Self extends Element>(this: Self): Self;
    size_neg_4_5<Self extends Element>(this: Self): Self;
    size_neg_5<Self extends Element>(this: Self): Self;
    size_neg_56<Self extends Element>(this: Self): Self;
    size_neg_5_6<Self extends Element>(this: Self): Self;
    size_neg_6<Self extends Element>(this: Self): Self;
    size_neg_64<Self extends Element>(this: Self): Self;
    size_neg_7<Self extends Element>(this: Self): Self;
    size_neg_72<Self extends Element>(this: Self): Self;
    size_neg_8<Self extends Element>(this: Self): Self;
    size_neg_80<Self extends Element>(this: Self): Self;
    size_neg_9<Self extends Element>(this: Self): Self;
    size_neg_96<Self extends Element>(this: Self): Self;
    size_neg_full<Self extends Element>(this: Self): Self;
    size_neg_px<Self extends Element>(this: Self): Self;
    size_px<Self extends Element>(this: Self): Self;
    text_2xl<Self extends Element>(this: Self): Self;
    text_3xl<Self extends Element>(this: Self): Self;
    text_base<Self extends Element>(this: Self): Self;
    text_center<Self extends Element>(this: Self): Self;
    text_decoration_0<Self extends Element>(this: Self): Self;
    text_decoration_1<Self extends Element>(this: Self): Self;
    text_decoration_2<Self extends Element>(this: Self): Self;
    text_decoration_4<Self extends Element>(this: Self): Self;
    text_decoration_8<Self extends Element>(this: Self): Self;
    text_decoration_none<Self extends Element>(this: Self): Self;
    text_decoration_solid<Self extends Element>(this: Self): Self;
    text_decoration_wavy<Self extends Element>(this: Self): Self;
    text_ellipsis<Self extends Element>(this: Self): Self;
    text_ellipsis_middle<Self extends Element>(this: Self): Self;
    text_ellipsis_start<Self extends Element>(this: Self): Self;
    text_left<Self extends Element>(this: Self): Self;
    text_lg<Self extends Element>(this: Self): Self;
    text_right<Self extends Element>(this: Self): Self;
    text_sm<Self extends Element>(this: Self): Self;
    text_xl<Self extends Element>(this: Self): Self;
    text_xs<Self extends Element>(this: Self): Self;
    top_0<Self extends Element>(this: Self): Self;
    top_0p5<Self extends Element>(this: Self): Self;
    top_1<Self extends Element>(this: Self): Self;
    top_10<Self extends Element>(this: Self): Self;
    top_11<Self extends Element>(this: Self): Self;
    top_112<Self extends Element>(this: Self): Self;
    top_12<Self extends Element>(this: Self): Self;
    top_128<Self extends Element>(this: Self): Self;
    top_16<Self extends Element>(this: Self): Self;
    top_1_12<Self extends Element>(this: Self): Self;
    top_1_2<Self extends Element>(this: Self): Self;
    top_1_3<Self extends Element>(this: Self): Self;
    top_1_4<Self extends Element>(this: Self): Self;
    top_1_5<Self extends Element>(this: Self): Self;
    top_1_6<Self extends Element>(this: Self): Self;
    top_1p5<Self extends Element>(this: Self): Self;
    top_2<Self extends Element>(this: Self): Self;
    top_20<Self extends Element>(this: Self): Self;
    top_24<Self extends Element>(this: Self): Self;
    top_2_3<Self extends Element>(this: Self): Self;
    top_2_4<Self extends Element>(this: Self): Self;
    top_2_5<Self extends Element>(this: Self): Self;
    top_2p5<Self extends Element>(this: Self): Self;
    top_3<Self extends Element>(this: Self): Self;
    top_32<Self extends Element>(this: Self): Self;
    top_3_4<Self extends Element>(this: Self): Self;
    top_3_5<Self extends Element>(this: Self): Self;
    top_3p5<Self extends Element>(this: Self): Self;
    top_4<Self extends Element>(this: Self): Self;
    top_40<Self extends Element>(this: Self): Self;
    top_48<Self extends Element>(this: Self): Self;
    top_4_5<Self extends Element>(this: Self): Self;
    top_5<Self extends Element>(this: Self): Self;
    top_56<Self extends Element>(this: Self): Self;
    top_5_6<Self extends Element>(this: Self): Self;
    top_6<Self extends Element>(this: Self): Self;
    top_64<Self extends Element>(this: Self): Self;
    top_7<Self extends Element>(this: Self): Self;
    top_72<Self extends Element>(this: Self): Self;
    top_8<Self extends Element>(this: Self): Self;
    top_80<Self extends Element>(this: Self): Self;
    top_9<Self extends Element>(this: Self): Self;
    top_96<Self extends Element>(this: Self): Self;
    top_auto<Self extends Element>(this: Self): Self;
    top_full<Self extends Element>(this: Self): Self;
    top_neg_0<Self extends Element>(this: Self): Self;
    top_neg_0p5<Self extends Element>(this: Self): Self;
    top_neg_1<Self extends Element>(this: Self): Self;
    top_neg_10<Self extends Element>(this: Self): Self;
    top_neg_11<Self extends Element>(this: Self): Self;
    top_neg_112<Self extends Element>(this: Self): Self;
    top_neg_12<Self extends Element>(this: Self): Self;
    top_neg_128<Self extends Element>(this: Self): Self;
    top_neg_16<Self extends Element>(this: Self): Self;
    top_neg_1_12<Self extends Element>(this: Self): Self;
    top_neg_1_2<Self extends Element>(this: Self): Self;
    top_neg_1_3<Self extends Element>(this: Self): Self;
    top_neg_1_4<Self extends Element>(this: Self): Self;
    top_neg_1_5<Self extends Element>(this: Self): Self;
    top_neg_1_6<Self extends Element>(this: Self): Self;
    top_neg_1p5<Self extends Element>(this: Self): Self;
    top_neg_2<Self extends Element>(this: Self): Self;
    top_neg_20<Self extends Element>(this: Self): Self;
    top_neg_24<Self extends Element>(this: Self): Self;
    top_neg_2_3<Self extends Element>(this: Self): Self;
    top_neg_2_4<Self extends Element>(this: Self): Self;
    top_neg_2_5<Self extends Element>(this: Self): Self;
    top_neg_2p5<Self extends Element>(this: Self): Self;
    top_neg_3<Self extends Element>(this: Self): Self;
    top_neg_32<Self extends Element>(this: Self): Self;
    top_neg_3_4<Self extends Element>(this: Self): Self;
    top_neg_3_5<Self extends Element>(this: Self): Self;
    top_neg_3p5<Self extends Element>(this: Self): Self;
    top_neg_4<Self extends Element>(this: Self): Self;
    top_neg_40<Self extends Element>(this: Self): Self;
    top_neg_48<Self extends Element>(this: Self): Self;
    top_neg_4_5<Self extends Element>(this: Self): Self;
    top_neg_5<Self extends Element>(this: Self): Self;
    top_neg_56<Self extends Element>(this: Self): Self;
    top_neg_5_6<Self extends Element>(this: Self): Self;
    top_neg_6<Self extends Element>(this: Self): Self;
    top_neg_64<Self extends Element>(this: Self): Self;
    top_neg_7<Self extends Element>(this: Self): Self;
    top_neg_72<Self extends Element>(this: Self): Self;
    top_neg_8<Self extends Element>(this: Self): Self;
    top_neg_80<Self extends Element>(this: Self): Self;
    top_neg_9<Self extends Element>(this: Self): Self;
    top_neg_96<Self extends Element>(this: Self): Self;
    top_neg_full<Self extends Element>(this: Self): Self;
    top_neg_px<Self extends Element>(this: Self): Self;
    top_px<Self extends Element>(this: Self): Self;
    truncate<Self extends Element>(this: Self): Self;
    underline<Self extends Element>(this: Self): Self;
    v_flex<Self extends Element>(this: Self): Self;
    visible<Self extends Element>(this: Self): Self;
    w_0<Self extends Element>(this: Self): Self;
    w_0p5<Self extends Element>(this: Self): Self;
    w_1<Self extends Element>(this: Self): Self;
    w_10<Self extends Element>(this: Self): Self;
    w_11<Self extends Element>(this: Self): Self;
    w_112<Self extends Element>(this: Self): Self;
    w_12<Self extends Element>(this: Self): Self;
    w_128<Self extends Element>(this: Self): Self;
    w_16<Self extends Element>(this: Self): Self;
    w_1_12<Self extends Element>(this: Self): Self;
    w_1_2<Self extends Element>(this: Self): Self;
    w_1_3<Self extends Element>(this: Self): Self;
    w_1_4<Self extends Element>(this: Self): Self;
    w_1_5<Self extends Element>(this: Self): Self;
    w_1_6<Self extends Element>(this: Self): Self;
    w_1p5<Self extends Element>(this: Self): Self;
    w_2<Self extends Element>(this: Self): Self;
    w_20<Self extends Element>(this: Self): Self;
    w_24<Self extends Element>(this: Self): Self;
    w_2_3<Self extends Element>(this: Self): Self;
    w_2_4<Self extends Element>(this: Self): Self;
    w_2_5<Self extends Element>(this: Self): Self;
    w_2p5<Self extends Element>(this: Self): Self;
    w_3<Self extends Element>(this: Self): Self;
    w_32<Self extends Element>(this: Self): Self;
    w_3_4<Self extends Element>(this: Self): Self;
    w_3_5<Self extends Element>(this: Self): Self;
    w_3p5<Self extends Element>(this: Self): Self;
    w_4<Self extends Element>(this: Self): Self;
    w_40<Self extends Element>(this: Self): Self;
    w_48<Self extends Element>(this: Self): Self;
    w_4_5<Self extends Element>(this: Self): Self;
    w_5<Self extends Element>(this: Self): Self;
    w_56<Self extends Element>(this: Self): Self;
    w_5_6<Self extends Element>(this: Self): Self;
    w_6<Self extends Element>(this: Self): Self;
    w_64<Self extends Element>(this: Self): Self;
    w_7<Self extends Element>(this: Self): Self;
    w_72<Self extends Element>(this: Self): Self;
    w_8<Self extends Element>(this: Self): Self;
    w_80<Self extends Element>(this: Self): Self;
    w_9<Self extends Element>(this: Self): Self;
    w_96<Self extends Element>(this: Self): Self;
    w_auto<Self extends Element>(this: Self): Self;
    w_full<Self extends Element>(this: Self): Self;
    w_neg_0<Self extends Element>(this: Self): Self;
    w_neg_0p5<Self extends Element>(this: Self): Self;
    w_neg_1<Self extends Element>(this: Self): Self;
    w_neg_10<Self extends Element>(this: Self): Self;
    w_neg_11<Self extends Element>(this: Self): Self;
    w_neg_112<Self extends Element>(this: Self): Self;
    w_neg_12<Self extends Element>(this: Self): Self;
    w_neg_128<Self extends Element>(this: Self): Self;
    w_neg_16<Self extends Element>(this: Self): Self;
    w_neg_1_12<Self extends Element>(this: Self): Self;
    w_neg_1_2<Self extends Element>(this: Self): Self;
    w_neg_1_3<Self extends Element>(this: Self): Self;
    w_neg_1_4<Self extends Element>(this: Self): Self;
    w_neg_1_5<Self extends Element>(this: Self): Self;
    w_neg_1_6<Self extends Element>(this: Self): Self;
    w_neg_1p5<Self extends Element>(this: Self): Self;
    w_neg_2<Self extends Element>(this: Self): Self;
    w_neg_20<Self extends Element>(this: Self): Self;
    w_neg_24<Self extends Element>(this: Self): Self;
    w_neg_2_3<Self extends Element>(this: Self): Self;
    w_neg_2_4<Self extends Element>(this: Self): Self;
    w_neg_2_5<Self extends Element>(this: Self): Self;
    w_neg_2p5<Self extends Element>(this: Self): Self;
    w_neg_3<Self extends Element>(this: Self): Self;
    w_neg_32<Self extends Element>(this: Self): Self;
    w_neg_3_4<Self extends Element>(this: Self): Self;
    w_neg_3_5<Self extends Element>(this: Self): Self;
    w_neg_3p5<Self extends Element>(this: Self): Self;
    w_neg_4<Self extends Element>(this: Self): Self;
    w_neg_40<Self extends Element>(this: Self): Self;
    w_neg_48<Self extends Element>(this: Self): Self;
    w_neg_4_5<Self extends Element>(this: Self): Self;
    w_neg_5<Self extends Element>(this: Self): Self;
    w_neg_56<Self extends Element>(this: Self): Self;
    w_neg_5_6<Self extends Element>(this: Self): Self;
    w_neg_6<Self extends Element>(this: Self): Self;
    w_neg_64<Self extends Element>(this: Self): Self;
    w_neg_7<Self extends Element>(this: Self): Self;
    w_neg_72<Self extends Element>(this: Self): Self;
    w_neg_8<Self extends Element>(this: Self): Self;
    w_neg_80<Self extends Element>(this: Self): Self;
    w_neg_9<Self extends Element>(this: Self): Self;
    w_neg_96<Self extends Element>(this: Self): Self;
    w_neg_full<Self extends Element>(this: Self): Self;
    w_neg_px<Self extends Element>(this: Self): Self;
    w_px<Self extends Element>(this: Self): Self;
    whitespace_normal<Self extends Element>(this: Self): Self;
    whitespace_nowrap<Self extends Element>(this: Self): Self;
  }
  export function div(): NativeElement;
  export function svg(path: string): NativeElement;
  export function image(path: string): NativeElement;
  export interface ItemRange {
    start: number;
    end: number;
  }
  export function list(
    id: string | number,
    item_count: number,
    get_key: (index: number) => string,
    render: (index: number, cx: Context) => Element,
  ): NativeElement;
  export function uniform_list(
    id: string | number,
    item_count: number,
    get_key: (index: number) => string,
    render: (range: ItemRange, cx: Context) => Element[],
  ): NativeElement;
  export interface Path {}
  export interface PathBuilder {
    move_to(x: import("gpui-shell").PathCoordinate, y: import("gpui-shell").PathCoordinate): PathBuilder;
    line_to(x: import("gpui-shell").PathCoordinate, y: import("gpui-shell").PathCoordinate): PathBuilder;
    curve_to(to_x: import("gpui-shell").PathCoordinate, to_y: import("gpui-shell").PathCoordinate, control_x: import("gpui-shell").PathCoordinate, control_y: import("gpui-shell").PathCoordinate): PathBuilder;
    cubic_bezier_to(to_x: import("gpui-shell").PathCoordinate, to_y: import("gpui-shell").PathCoordinate, control_a_x: import("gpui-shell").PathCoordinate, control_a_y: import("gpui-shell").PathCoordinate, control_b_x: import("gpui-shell").PathCoordinate, control_b_y: import("gpui-shell").PathCoordinate): PathBuilder;
    arc_to(radius_x: import("gpui-shell").PathCoordinate, radius_y: import("gpui-shell").PathCoordinate, rotation: number, large_arc: boolean, sweep: boolean, to_x: import("gpui-shell").PathCoordinate, to_y: import("gpui-shell").PathCoordinate): PathBuilder;
    add_polygon(points: ReadonlyArray<readonly [import("gpui-shell").PathCoordinate, import("gpui-shell").PathCoordinate]>, closed?: boolean): PathBuilder;
    close(): PathBuilder;
    dash_array(values: readonly number[]): PathBuilder;
    build(): Path;
  }
  export const PathBuilder: {
    fill(): PathBuilder;
    stroke(width: number): PathBuilder;
  };
  export interface BackgroundStop {}
  export interface Background {
    opacity(factor: number): Background;
    color_space(space: "srgb" | "oklab"): Background;
  }
  export const Background: {
    solid(color: Color): Background;
    stop(color: Color, percentage: number): BackgroundStop;
    linear_gradient(angle: number, from: Color | BackgroundStop, to: Color | BackgroundStop): Background;
    pattern_slash(color: Color, width: number, interval: number): Background;
    checkerboard(color: Color, size: number): Background;
  };
  export interface FocusHandle {
    focus(): void;
    is_focused(): boolean;
    release(): boolean;
  }
  export interface Window {
    open_dialog(content: () => Element, options?: import("gpui-shell").DialogOptions): number;
    close_dialog(): boolean;
    close_all_dialogs(): number;
    has_active_dialog(): boolean;
    open_sheet(content: () => Element): void;
    open_sheet_at(placement: import("gpui-base").Placement, content: () => Element): void;
    close_sheet(): boolean;
    has_active_sheet(): boolean;
    push_toast(options: import("gpui-shell").ToastOptions): string;
    remove_toast(id: string): boolean;
    clear_toasts(): number;
    readonly localStorage: Storage;
    readonly sessionStorage: Storage;
    paint_path(path: Path, background: Background | Color): NativeElement;
    dispatch_action(action: string): void;
    rem_size(): number;
    line_height(): number;
    viewport_size(): Size;
    bounds(): import("gpui-shell").ElementBounds;
    mouse_position(): Point;
    appearance(): "light" | "dark";
    is_window_active(): boolean;
    is_fullscreen(): boolean;
    is_maximized(): boolean;
    set_rem_size(size: number): void;
    refresh(): void;
    focus_next(): void;
    focus_prev(): void;
    activate_window(): void;
    minimize_window(): void;
    zoom_window(): void;
    toggle_fullscreen(): void;
  }
  export interface Storage {
    readonly length: number;
    key(index: number): string | null;
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
    clear(): void;
    flush(): Promise<void>;
  }
  export interface Task {
    cancel(): void;
    is_done(): boolean;
  }
  export interface Timer {
    after(ms: number, handler: (cx: AsyncContext) => void, opts?: import("gpui-shell").TaskOptions): Task;
    every(ms: number, handler: (cx: AsyncContext) => void, opts?: import("gpui-shell").TaskOptions): Task;
  }
}
declare module "gpui" {
  export * from "gpui-kit";
}
declare module "gpui-base" {
  import {
    Color,
    Context,
    Element,
    NativeElement,
    FocusHandle,
  } from "gpui-kit";
  export type ColorToken =
    | "background"
    | "foreground"
    | "surface"
    | "surface_foreground"
    | "primary"
    | "primary_foreground"
    | "secondary"
    | "secondary_foreground"
    | "muted"
    | "muted_foreground"
    | "accent"
    | "accent_foreground"
    | "destructive"
    | "destructive_foreground"
    | "border"
    | "input"
    | "ring"
    | "selection"
    ;
  export type Placement = "top" | "bottom" | "left" | "right";
  export interface ComponentType {
    new: (id: string | number) => NativeElement;
  }
  export interface PartType {
    new: () => NativeElement;
  }
  export interface InputRange { start: number; end: number }
  export interface InlineToken { id: string; text: string; label?: string }
  export interface InlineTokenSpan { range: InputRange; token: InlineToken }
  export interface InputContent { text: string; tokens: InlineTokenSpan[] }
  export interface InlineTokenContext extends InlineTokenSpan {
    selected: boolean; disabled: boolean; readonly: boolean;
    line_height: number; available_width: number;
  }
  export interface InlineTokenClickEvent extends InlineTokenSpan {
    bounds: { x: number; y: number; width: number; height: number };
    modifiers: { shift: boolean; alt: boolean; control: boolean; platform: boolean };
  }
  export interface InlineTokenHoverEvent extends InlineTokenSpan {
    hovered: boolean;
    bounds: { x: number; y: number; width: number; height: number };
  }
  export function h_flex(): NativeElement;
  export function v_flex(): NativeElement;
  export const Button: ComponentType;
  export const Link: ComponentType;
  export const Checkbox: ComponentType;
  export const Switch: ComponentType;
  export interface TextViewElement extends NativeElement {
    on_link_click(handler: (url: string, cx: Context) => void): this;
    selectable(value?: boolean): this;
    scrollable(value?: boolean): this;
  }
  export const TextView: {
    html(id: string, html: string): TextViewElement;
    markdown(id: string, markdown: string): TextViewElement;
  };
  export const Tabs: ComponentType;
  export const Tab: ComponentType;
  export const Progress: ComponentType;
  export const ProgressTrack: PartType;
  export const ProgressIndicator: PartType;
  export const Avatar: PartType;
  export const AvatarImage: { new(path: string): Element };
  export const AvatarFallback: PartType;
  export const Pagination: ComponentType;
  export const Accordion: ComponentType;
  export const AccordionItem: PartType;
  export const AccordionHeader: { new(trigger: Element): Element };
  export const AccordionPanel: PartType;
  export const AccordionTrigger: ComponentType;
  export const CalendarState: { new(): CalendarStateHandle };
  export type CalendarDate = string | [string | null, string | null] | null;
  export interface CalendarStateHandle {
    month_days(): string[][][];
    year(): number;
    month(): number;
    today(): string;
    value(): CalendarDate;
    set_value(next: CalendarDate): void;
    next_month(): void;
    prev_month(): void;
    on(event: "change", handler: (date: CalendarDate, cx: Context) => void): boolean;
    release(): boolean;
  }
  export function pagination_items(
    current_page: number,
    total_pages: number,
    visible_pages?: number,
  ): PaginationEntry[];
  export type PaginationEntry =
    | { page: number; ellipsis?: undefined }
    | { ellipsis: [first: number, last: number]; page?: undefined };
  export const Radio: ComponentType;
  export const Toggle: ComponentType;
  export const RadioGroup: ComponentType;
  export const ToggleGroup: ComponentType;
  export const Table: ComponentType;
  export const TableHeader: ComponentType;
  export const TableBody: ComponentType;
  export const TableRow: { new: (id: string | number, row_index: number) => NativeElement };
  export const TableHead: { new: (id: string | number, column_index: number) => NativeElement };
  export const TableCell: { new: (id: string | number, column_index: number) => NativeElement };
  export const TableCaption: ComponentType;
  export function h_resizable(id: string): NativeElement;
  export function v_resizable(id: string): NativeElement;
  export function resizable_panel(): NativeElement;
  export const Collapsible: PartType;
  export const Popover: ComponentType;
  export const HoverCard: ComponentType;
  export const Popup: {
    new: (id: string | number, trigger: Element) => NativeElement;
  };
  export const Select: ComponentType;
  export const Combobox: ComponentType;
  export const DatePicker: {
    new: (id: string | number, focus_handle: FocusHandle) => NativeElement;
  };
  export type ScrollbarMode = "scrolling" | "hover" | "always";
  export const Scrollbar: {
    new: (id: string | number) => NativeElement;
    horizontal: (id: string | number) => NativeElement;
    vertical: (id: string | number) => NativeElement;
  };
  export type ItemRange = import("gpui-kit").ItemRange;
  export function v_virtual_list(
    id: string | number,
    item_count: number,
    item_sizes: number | number[],
    get_key: (index: number) => string,
    render: (range: ItemRange, cx: Context) => Element[],
  ): NativeElement;
  export function h_virtual_list(
    id: string | number,
    item_count: number,
    item_sizes: number | number[],
    get_key: (index: number) => string,
    render: (range: ItemRange, cx: Context) => Element[],
  ): NativeElement;
  export interface ScrollHandle {
    scroll_to_item(index: number): void;
    release(): boolean;
  }
  export const ScrollHandle: { new: () => ScrollHandle };
  export interface VirtualListScrollHandle {
    scroll_to_item(index: number, strategy?: "top" | "center"): void;
    scroll_to_bottom(): void;
    release(): boolean;
  }
  export const VirtualListScrollHandle: {
    new: () => VirtualListScrollHandle;
  };
  export interface InputEvent {
    readonly secondary?: boolean;
    readonly shift?: boolean;
  }
  export interface OtpEvent {}
  export interface InputState {
    content(): InputContent;
    tokens(): InlineTokenSpan[];
    replace_with_token(token: InlineToken): void;
    replace_range_with_token(range: InputRange, token: InlineToken): void;
    set_selected_range(range: InputRange): void;
    replace(text: string): void;
    value(): string;
    set_value(next: string | InputContent): void;
    on(event: "change" | "submit" | "focus" | "blur" | "paste_other", handler: (event: InputEvent, cx: Context) => void): boolean;
    set_step(step: number | null): void;
    set_min(min: number | null): void;
    set_max(max: number | null): void;
    set_masked(masked: boolean): void;
    set_loading(loading: boolean): void;
    focus(): void;
    release(): boolean;
  }
  export const InputState: {
    new: (options?: { placeholder?: string; value?: string }) => InputState;
  };
  export const Input: { new: (state: InputState) => NativeElement };
  export const NumberInput: { new: (state: InputState) => NativeElement };
  export interface TextareaState {
    content(): InputContent;
    tokens(): InlineTokenSpan[];
    replace_with_token(token: InlineToken): void;
    replace_range_with_token(range: InputRange, token: InlineToken): void;
    set_selected_range(range: InputRange): void;
    replace(text: string): void;
    value(): string;
    set_value(next: string | InputContent): void;
    on(event: "change" | "submit" | "focus" | "blur" | "paste_other", handler: (event: InputEvent, cx: Context) => void): boolean;
    set_rows(rows: number): void;
    set_auto_grow(min_rows: number, max_rows: number): void;
    set_soft_wrap(wrap: boolean): void;
    focus(): void;
    release(): boolean;
  }
  export const TextareaState: {
    new: (options?: { placeholder?: string; value?: string; rows?: number }) => TextareaState;
  };
  export const Textarea: { new: (state: TextareaState) => NativeElement };
  export interface EditorState {
    value(): string;
    set_value(value: string): void;
    on(event: "change" | "submit" | "focus" | "blur" | "paste_other", handler: (event: InputEvent, cx: Context) => void): boolean;
    release(): boolean;
  }
  export const EditorState: {
    new: (options?: {
      language?: string;
      value?: string;
      font_family?: string;
      font_size?: number;
      line_numbers?: boolean;
      folding?: boolean;
      readonly?: boolean;
      soft_wrap?: boolean;
      syntax?: Record<string, string>;
    }) => EditorState;
  };
  export const Editor: { new: (state: EditorState) => NativeElement };
  export type SliderValue = number | [number, number];
  export interface SliderState {
    value(): SliderValue;
    set_value(next: SliderValue): void;
    min_value(): number;
    max_value(): number;
    step_value(): number;
    on(event: "change" | "release", handler: (value: SliderValue, cx: Context) => void): boolean;
    release(): boolean;
  }
  export const SliderState: {
    new: (options?: {
      min?: number;
      max?: number;
      step?: number;
      scale?: "linear" | "logarithmic";
      value?: SliderValue;
    }) => SliderState;
  };
  export const Slider: { new: (state: SliderState) => NativeElement };
  export const SliderTrack: { new: (state: SliderState) => NativeElement };
  export const SliderIndicator: { new: (state: SliderState) => NativeElement };
  export const SliderThumb: { new: (state: SliderState) => NativeElement };
  export interface OtpState {
    value(): string;
    set_value(next: string): void;
    len(): number;
    is_masked(): boolean;
    set_masked(masked: boolean): void;
    focus(): void;
    on(event: "change" | "complete" | "focus" | "blur", handler: (event: OtpEvent, cx: Context) => void): boolean;
    release(): boolean;
  }
  export const OtpState: {
    new: (length: number, options?: { value?: string; masked?: boolean }) => OtpState;
  };
  export const OtpInput: { new: (state: OtpState) => NativeElement };
  export type DockPlacement = "center" | "left" | "right" | "bottom";
  export interface DockPanel {
    readonly id: number;
    readonly name: string;
    readonly placement: DockPlacement;
    readonly node: number;
    readonly index: number;
    readonly active: boolean;
    readonly visible: boolean;
    readonly closable: boolean;
    readonly zoomable: boolean;
  }
  export interface DockTab {
    readonly index: number;
    readonly name: string;
    readonly id: number;
    readonly active: boolean;
    readonly visible: boolean;
    readonly closable: boolean;
    readonly zoomable: boolean;
  }
  export interface DockGroup {
    readonly node: number;
    readonly active_index: number;
    readonly zoomed: boolean;
    readonly collapsed: boolean;
    readonly locked: boolean;
    readonly draggable: boolean;
    readonly droppable: boolean;
    readonly closable: boolean;
    readonly tabs: readonly DockTab[];
  }
  export interface DockRegion {
    readonly placement: DockPlacement;
    readonly size: number;
    readonly open: boolean;
    readonly collapsible: boolean;
  }
  export interface DockDrop {
    readonly placement: Placement | null;
    readonly bounds: import("gpui-shell").ElementBounds;
    readonly from: import("gpui-shell").ElementBounds;
    readonly to: import("gpui-shell").ElementBounds;
  }
  export interface DockPanelOptions {
    name: string;
    placement?: DockPlacement;
    size?: number;
    closable?: boolean;
    zoomable?: boolean;
    visible?: boolean;
  }
  export interface DockArea {
    add_panel(view: import("gpui-kit").Entity, options: DockPanelOptions): void;
    remove_panel(id: number): void;
    panels(): DockPanel[];
    dump(): any;
    load(state: any): void;
    has_dock(placement: DockPlacement): boolean;
    is_dock_open(placement: DockPlacement): boolean;
    toggle_dock(placement: DockPlacement): void;
    remove_dock(placement: DockPlacement): void;
    dock_size(placement: DockPlacement): number | null;
    set_dock_size(placement: DockPlacement, size: number): void;
    set_dock_collapsible(placement: DockPlacement, collapsible: boolean): void;
    is_locked(): boolean;
    set_locked(locked: boolean): void;
    is_zoomed(): boolean;
    zoom_out(): void;
    on(event: "layout_changed", handler: (cx: Context) => void): boolean;
    release(): boolean;
  }
  export const DockArea: {
    new: (id: string, options?: { version?: number }) => DockArea;
    register_panel: (name: string, Class: import("gpui-kit").ViewClass) => string;
  };
  export function dock_area(area: DockArea): DockAreaElement;
  export interface DockAreaElement extends NativeElement {
    tab_bar(handler: (group: DockGroup, cx: Context) => Element): DockAreaElement;
    empty_group(handler: (group: DockGroup, cx: Context) => Element | null): DockAreaElement;
    drop_indicator(handler: (drop: DockDrop, cx: Context) => Element | null): DockAreaElement;
    dock(handler: (dock: DockRegion, cx: Context) => Element | null): DockAreaElement;
  }
  export function dock_content(): NativeElement;
  export type ColorTokens = { readonly [Role in ColorToken]: Color };
  export interface SpacingTokens {
    readonly xxs: number; readonly xs: number; readonly sm: number;
    readonly md: number; readonly lg: number; readonly xl: number; readonly xxl: number;
  }
  export interface RadiusTokens {
    readonly none: number; readonly sm: number; readonly md: number;
    readonly lg: number; readonly xl: number; readonly full: number;
  }
  export interface TextStyleToken {
    readonly size: number;
    readonly line_height: number;
    readonly weight: number;
  }
  export interface TypographyTokens {
    readonly sans: string;
    readonly xs: TextStyleToken; readonly sm: TextStyleToken; readonly md: TextStyleToken;
    readonly lg: TextStyleToken; readonly xl: TextStyleToken;
    readonly mono: string;
    readonly mono_md: TextStyleToken;
  }
  export interface SemanticThemeTokens {
    readonly colors: ColorTokens;
    readonly spacing: SpacingTokens;
    readonly radius: RadiusTokens;
    readonly typography: TypographyTokens;
  }
  export function set_theme(theme: {
    readonly appearance: "light" | "dark";
    readonly tokens: Omit<SemanticThemeTokens, "typography"> & {
      readonly typography?: {
        readonly sans?: string;
        readonly mono?: string;
      } & {
        readonly [Step in keyof Omit<TypographyTokens, "sans" | "mono">]?: {
          readonly [Field in keyof TextStyleToken]?: number;
        };
      };
    };
  }): void;
  export interface Theme extends SemanticThemeTokens, ColorTokens {
    readonly appearance: "light" | "dark";
    readonly is_dark: boolean;
  }
}
declare module "gpui-component" {
  import { ClickEvent, Context, Element, NativeElement } from "gpui-kit";
  export interface InputRange { start: number; end: number }
  export interface InlineToken { id: string; text: string; label?: string }
  export interface InlineTokenSpan { range: InputRange; token: InlineToken }
  export interface InputContent { text: string; tokens: InlineTokenSpan[] }
  export interface InlineTokenContext extends InlineTokenSpan {
    selected: boolean; disabled: boolean; readonly: boolean;
    line_height: number; available_width: number;
  }
  export interface InlineTokenClickEvent extends InlineTokenSpan {
    bounds: { x: number; y: number; width: number; height: number };
    modifiers: { shift: boolean; alt: boolean; control: boolean; platform: boolean };
  }
  export interface InlineTokenHoverEvent extends InlineTokenSpan {
    hovered: boolean;
    bounds: { x: number; y: number; width: number; height: number };
  }
}
declare module "gpui-shell" {
  export type LengthString = `${number}px` | `${number}rem` | `${number}%`;
  export type ScopePhase =
    | "render"
    | "event"
    | "task"
    | "layout"
    | "none"
    ;
  export type PathCoordinate = number | `${number}%`;
  export type Props = Record<string, any>;
  type ImportedPoint = import("gpui-kit").Point;
  export interface ElementBounds extends ImportedPoint {
    width: number;
    height: number;
  }
  export interface DialogOptions {
    escape_dismissable?: boolean;
    backdrop_dismissable?: boolean;
  }
  export interface ToastOptions {
    title: string;
    description?: string;
    level?: "info" | "success" | "warning" | "error";
    timeout?: number | null;
    id?: string;
  }
  export interface TaskOptions {
    owner?: import("gpui-kit").View | null;
  }
  export type MotionProperty = "opacity" | "width" | "height" | "left" | "top";
  export type MotionEasing = "linear" | "ease-in" | "ease-out" | "ease-in-out";
  export interface TransitionPolicy {
    duration: number;
    delay?: number;
    easing?: MotionEasing;
  }
  export interface LoopPolicy {
    from: number;
    to: number;
    period?: number;
    easing?: MotionEasing;
  }
  export interface SpringPolicy {
    response?: number;
    damping?: number;
    epsilon?: number;
  }
}
declare module "gpui-fps" {
  import { Anchor, Element, NativeElement } from "gpui-kit";
  export function fps_monitor(): NativeElement;
  export interface FpsMonitorOptions {
    anchor?: Anchor;
    frame_budget?: number;
  }
  export function show_fps_monitor(options?: FpsMonitorOptions): void;
  export function hide_fps_monitor(): boolean;
  export function fps_monitor_visible(): boolean;
}
declare module "buffer" {
  export class Buffer extends Uint8Array {
    static from(value: string | ArrayBuffer | ArrayLike<number>, encoding?: string): Buffer;
    static alloc(size: number): Buffer;
    toString(encoding?: string): string;
  }
}
declare module "path" {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string, suffix?: string): string;
  const path: { join: typeof join; resolve: typeof resolve; dirname: typeof dirname; basename: typeof basename };
  export default path;
}
declare module "url" {
  export const URL: typeof globalThis.URL;
  export const URLSearchParams: typeof globalThis.URLSearchParams;
}
declare module "crypto" {
  export interface Hash { update(data: string | Uint8Array): Hash; digest(encoding?: string): string | import("buffer").Buffer; }
  export function createHash(algorithm: string): Hash;
  export function randomBytes(size: number): import("buffer").Buffer;
  export function randomUUID(): string;
  export const webcrypto: Crypto;
}
declare module "zlib" {
  export function deflateSync(data: string | Uint8Array): import("buffer").Buffer;
  export function inflateSync(data: Uint8Array): import("buffer").Buffer;
  export function gzipSync(data: string | Uint8Array): import("buffer").Buffer;
  export function gunzipSync(data: Uint8Array): import("buffer").Buffer;
}
interface Console {
  debug(...values: unknown[]): void;
  log(...values: unknown[]): void;
  info(...values: unknown[]): void;
  warn(...values: unknown[]): void;
  error(...values: unknown[]): void;
}
declare const console: Console;
declare module "console" {
  const console: Console;
  export default console;
}
declare module "process" {
  export interface CommandOutput { code: number; stdout: string; stderr: string; }
  export function run(command: string, args?: string[]): Promise<CommandOutput>;
  export function exit(code?: number): void;
  export function nextTick(callback: (...args: unknown[]) => void, ...args: unknown[]): void;
  export const platform: string;
  export const arch: string;
  const process: { run: typeof run; exit: typeof exit; nextTick: typeof nextTick; platform: string; arch: string };
  export default process;
}
declare module "os" {
  export function platform(): string;
  export function arch(): string;
  export const EOL: string;
  const os: { platform: typeof platform; arch: typeof arch; EOL: string };
  export default os;
}
declare module "fs/promises" {
  export interface Dirent { name: string; isDirectory(): boolean; }
  export interface MakeDirectoryOptions { recursive?: boolean; }
  export function readFile(path: string): Promise<Uint8Array>;
  export function readFile(path: string, encoding: "utf8" | { encoding: "utf8" }): Promise<string>;
  export function writeFile(path: string, contents: string | Uint8Array): Promise<void>;
  export function readdir(path: string): Promise<string[]>;
  export function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  export function exists(path: string): Promise<boolean>;
  export function unlink(path: string): Promise<void>;
  export function rmdir(path: string): Promise<void>;
  export function mkdir(path: string, options?: MakeDirectoryOptions): Promise<void>;
}
declare module "net" {
  export interface Socket {
    write(data: string): Promise<void>;
    read(maxBytes?: number): Promise<Uint8Array | null>;
    close(): void;
  }
  export function connect(host: string, port: number): Promise<Socket>;
  const net: { connect: typeof connect };
  export default net;
}
declare module "websocket" {
  export interface WebSocketSocket {
    read(): Promise<string | Uint8Array>;
    write(data: string | Uint8Array): Promise<void>;
    close(): Promise<void>;
  }
  export interface WebSocketConnectOptions {
    headers?: Readonly<Record<string, string>>;
  }
  export interface WebSocketType {
    connect(url: string, options?: WebSocketConnectOptions): Promise<WebSocketSocket>;
  }
  export const WebSocket: WebSocketType;
}
interface ShellFetchResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly url: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
}
interface ShellFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}
declare function fetch(url: string, options?: ShellFetchOptions): Promise<ShellFetchResponse>;
declare const process: typeof import("process").default;
type GpuiShellWindow = import("gpui-kit").Window;
interface Window extends GpuiShellWindow {}
declare var window: Window & typeof globalThis;
declare const localStorage: import("gpui-kit").Storage;
declare const sessionStorage: import("gpui-kit").Storage;
