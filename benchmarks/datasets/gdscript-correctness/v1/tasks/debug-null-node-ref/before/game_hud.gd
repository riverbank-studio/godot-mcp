## Scene tree has: UI/ScoreLabel (Label), UI/HealthBar (ProgressBar)
extends Control

@onready var _label: Label = $HUD/ScoreLabel    # bug: wrong path, should be $UI/ScoreLabel
@onready var _health_bar: ProgressBar = $UI/HealthBar

var score: int = 0

func add_score(points: int) -> void:
	score += points
	_label.text = "Score: %d" % score
