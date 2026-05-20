extends Node

const HIGHSCORE_PATH := "user://highscore.dat"

var score: int = 0
var high_score: int = 0

func _ready() -> void:
	load_high_score()

func add_score(points: int) -> void:
	score += points
	if score > high_score:
		high_score = score

func reset_score() -> void:
	score = 0

func save_high_score() -> void:
	var file := FileAccess.open(HIGHSCORE_PATH, FileAccess.WRITE)
	if file:
		file.store_32(high_score)

func load_high_score() -> void:
	if not FileAccess.file_exists(HIGHSCORE_PATH):
		return
	var file := FileAccess.open(HIGHSCORE_PATH, FileAccess.READ)
	if file:
		high_score = file.get_32()
